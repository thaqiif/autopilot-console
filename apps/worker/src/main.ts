import { access, constants } from "node:fs/promises";
import { hostname } from "node:os";
import { CliAutopilotRunner } from "../../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createDatabaseClient,
	createDevelopmentQueue,
} from "../../../packages/database/src/index";
import { CliGitGateway } from "../../../packages/git/src/index";
import {
	createDiagnosticLogRetention,
	createMetricsCollector,
	createStructuredLogger,
	loadRuntimeConfig,
	redactSecrets,
} from "../../../packages/shared/src/index";
import { createDevelopmentWorker } from "./development/development-worker";
import { reconcileOrphansAtWorkerStartup } from "./runtime/startup-reconciliation";
import { createWorkerRegistrationService } from "./runtime/worker-registration";
import { createConcurrentDevelopmentWorkerRuntime } from "./runtime/worker-runtime";

export { reconcileOrphansAtWorkerStartup } from "./runtime/startup-reconciliation";
export {
	createConcurrentDevelopmentWorkerRuntime,
	createWorkerRuntime,
	type SlotStartResult,
	type WorkerRuntime,
	type WorkerRuntimeOptions,
	type WorkerRuntimeOutcome,
} from "./runtime/worker-runtime";

const WORKER_HEARTBEAT_MS = 10_000;
const IDLE_POLL_MS = 1_000;
const METRICS_EMIT_MS = 30_000;
const DIAGNOSTIC_PRUNE_MS = 60_000;

const logger = createStructuredLogger({
	baseContext: { service: "worker" },
});
const metrics = createMetricsCollector();

async function validateAgentCli(agentBin: string | undefined): Promise<void> {
	const configured = agentBin?.trim();
	if (!configured) {
		throw new Error("AGENT_BIN is required so the worker can validate the configured agent CLI");
	}
	if (configured.includes("/") || configured.startsWith(".")) {
		await access(configured, constants.X_OK);
		return;
	}
	const resolved = Bun.which(configured);
	if (!resolved) {
		throw new Error(`Configured agent CLI is not executable on PATH: ${configured}`);
	}
}

export async function runWorker(signal: AbortSignal): Promise<void> {
	const config = loadRuntimeConfig();
	const database = createDatabaseClient(config.database.url);
	const workerId = process.env.WORKER_ID?.trim() || `${hostname()}-${process.pid}`;
	const capacity = config.worker.maxConcurrentJobs;
	const diagnostics = createDiagnosticLogRetention({
		rootDir: process.env.DIAGNOSTIC_LOG_DIR?.trim() || "/app/logs",
	});
	try {
		await applyCoreMigration(database.sql);
		await applyWorkflowMigration(database.sql);
		await validateAgentCli(process.env.AGENT_BIN);
		const autopilot = new CliAutopilotRunner({ executablePath: process.env.AUTOPILOTAGENT_BIN });
		const runtimeCheck = await autopilot.validateRuntime();
		if (!runtimeCheck.ok)
			throw new Error(`Autopilot runtime is unavailable: ${runtimeCheck.message}`);

		const registrationService = createWorkerRegistrationService({
			sql: database.sql,
			workerId,
			hostname: hostname(),
			capacity,
		});
		const registration = await registrationService.register();
		await reconcileOrphansAtWorkerStartup(database.sql);
		const queue = createDevelopmentQueue(database.sql, {
			maxConcurrent: capacity,
		});
		const worker = createDevelopmentWorker({
			sql: database.sql,
			queue,
			git: new CliGitGateway(),
			autopilot,
			workerId,
			workerRegistrationId: registration.id,
		});

		const supervisor = createConcurrentDevelopmentWorkerRuntime({
			capacity,
			worker,
			heartbeatIntervalMs: WORKER_HEARTBEAT_MS,
			idlePollMs: IDLE_POLL_MS,
			heartbeat: async (activeJobs) => {
				await registrationService.heartbeat(registration.id, activeJobs);
				metrics.setHeartbeatAge(0);
				metrics.setActiveJobs(activeJobs, capacity);
			},
			onActiveJobsChange: (activeJobs) => {
				metrics.setActiveJobs(activeJobs, capacity);
			},
		});

		logger.info("worker started", {
			workerId,
			capacity,
			diagnosticRoot: diagnostics.rootDir,
			agentBin: process.env.AGENT_BIN,
			autopilotBin: process.env.AUTOPILOTAGENT_BIN,
		});

		let lastMetricsEmit = 0;
		let lastPrune = 0;
		const background = (async () => {
			while (!signal.aborted) {
				const now = Date.now();
				if (now - lastMetricsEmit >= METRICS_EMIT_MS) {
					const queueStats = await database.sql`
						SELECT
							count(*)::int AS depth,
							COALESCE(
								EXTRACT(EPOCH FROM (now() - min(created_at))) * 1000,
								0
							)::bigint AS oldest_age
						FROM development_job_attempts
						WHERE status = 'QUEUED'
					`.catch(() => [{ depth: 0, oldest_age: 0 }]);
					const depth = Number(queueStats[0]?.depth ?? 0);
					const oldestAge = Number(queueStats[0]?.oldest_age ?? 0);
					metrics.setQueueDepth(depth, oldestAge);
					logger.info("worker metrics", {
						workerId,
						activeJobs: supervisor.activeCount(),
						capacity: supervisor.capacity(),
						metrics: metrics.snapshot(),
					});
					lastMetricsEmit = now;
				}
				if (now - lastPrune >= DIAGNOSTIC_PRUNE_MS) {
					const pruned = await diagnostics.prune();
					if (pruned.removed > 0) {
						logger.info("diagnostic retention pruned", {
							workerId,
							removed: pruned.removed,
							remainingBytes: pruned.remainingBytes,
						});
					}
					lastPrune = now;
				}
				await waitForAbort(signal, 1_000);
			}
		})();

		await supervisor.run(signal);
		await background.catch(() => undefined);

		await database.sql`
			UPDATE worker_registrations SET stopped_at = now(), active_jobs = 0
			WHERE id = ${registration.id}
		`;
		logger.info("worker stopped", { workerId });
	} finally {
		await database.end();
	}
}

function waitForAbort(signal: AbortSignal, durationMs: number): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, durationMs);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

if (import.meta.main) {
	const controller = new AbortController();
	process.once("SIGTERM", () => controller.abort());
	process.once("SIGINT", () => controller.abort());
	runWorker(controller.signal).catch((error) => {
		const detail = error instanceof Error ? redactSecrets(error.message) : "unknown worker error";
		logger.error("worker stopped", { detail });
		process.exit(1);
	});
}
