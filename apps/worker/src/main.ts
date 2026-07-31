import { access, constants } from "node:fs/promises";
import { hostname } from "node:os";
import { type AutopilotRunHandle, CliAutopilotRunner } from "../../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createDatabaseClient,
	createDevelopmentQueue,
} from "../../../packages/database/src/index";
import { CliGitGateway } from "../../../packages/git/src/index";
import { GhCliGateway } from "../../../packages/github/src/index";
import {
	applyRuntimeMetricEvent,
	createDiagnosticLogRetention,
	createMetricsCollector,
	createStructuredLogger,
	loadRuntimeConfig,
	PRODUCTION_DIAGNOSTIC_LIMITS,
	type RuntimeMetricEvent,
	redactSecrets,
} from "../../../packages/shared/src/index";
import { createDevelopmentWorker } from "./development/development-worker";
import { createWorkerHealthServer } from "./health/worker-health-server";
import { createCancellationController } from "./process/cancellation-controller";
import { createProcessTreeInspector } from "./process/process-tree";
import { createRetryService } from "./process/retry-service";
import { createGithubRuntime } from "./runtime/github-runtime";
import { createJobCommandWorker } from "./runtime/job-command-worker";
import { reconcileOrphansAtWorkerStartup } from "./runtime/startup-reconciliation";
import { createWorkerRegistrationService } from "./runtime/worker-registration";
import { createConcurrentDevelopmentWorkerRuntime } from "./runtime/worker-runtime";

export type {
	GithubRuntime,
	GithubRuntimeOptions,
	HandoffProcessResult,
} from "./runtime/github-runtime";
export { createGithubRuntime } from "./runtime/github-runtime";
export type {
	JobCommandWorker,
	JobCommandWorkerOptions,
	ProcessPendingCancelsResult,
} from "./runtime/job-command-worker";
export { createJobCommandWorker } from "./runtime/job-command-worker";
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

function onMetric(event: RuntimeMetricEvent): void {
	applyRuntimeMetricEvent(metrics, event);
}

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
		maxFileBytes: PRODUCTION_DIAGNOSTIC_LIMITS.maxFileBytes,
		maxPerAttemptBytes: PRODUCTION_DIAGNOSTIC_LIMITS.maxPerAttemptBytes,
		maxTotalBytes: PRODUCTION_DIAGNOSTIC_LIMITS.maxTotalBytes,
		maxAgeMs: PRODUCTION_DIAGNOSTIC_LIMITS.maxAgeMs,
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
		const processTree = createProcessTreeInspector();
		const cancellation = createCancellationController({
			sql: database.sql,
			tree: processTree,
		});
		// Safe retry uses process-tree identity for liveness, not request-scoped probes.
		const retry = createRetryService({
			sql: database.sql,
			autopilot: {
				async isAlive(handle: AutopilotRunHandle) {
					return processTree.verifyIdentity(
						handle.processIdentity.pid,
						handle.processIdentity.startTimeMs,
					);
				},
			} as never,
		});
		const jobCommands = createJobCommandWorker({
			sql: database.sql,
			workerId,
			workerRegistrationId: registration.id,
			cancellation,
			retry,
			reconcileOrphans: () => reconcileOrphansAtWorkerStartup(database.sql),
			onMetric,
		});
		const git = new CliGitGateway();
		const github = new GhCliGateway();
		const worker = createDevelopmentWorker({
			sql: database.sql,
			queue,
			git,
			autopilot,
			workerId,
			workerRegistrationId: registration.id,
			logger,
			onMetric,
			diagnostics,
		});
		const githubRuntime = createGithubRuntime({
			sql: database.sql,
			git,
			github,
			workerId,
			pollIntervalMs: config.github.pollIntervalSeconds * 1_000,
			handoffPollIntervalMs: IDLE_POLL_MS,
			onMetric,
		});

		const supervisor = createConcurrentDevelopmentWorkerRuntime({
			capacity,
			worker,
			heartbeatIntervalMs: WORKER_HEARTBEAT_MS,
			idlePollMs: IDLE_POLL_MS,
			heartbeat: async (activeJobs) => {
				await registrationService.heartbeat(registration.id, activeJobs);
				onMetric({ type: "heartbeat_age", ageMs: 0 });
				onMetric({ type: "active_jobs", count: activeJobs, maxConcurrent: capacity });
			},
			onActiveJobsChange: (activeJobs) => {
				onMetric({ type: "active_jobs", count: activeJobs, maxConcurrent: capacity });
			},
		});

		let healthReady = true;
		const healthServer = createWorkerHealthServer({
			isReady: () => healthReady,
		});
		logger.info("worker started", {
			workerId,
			capacity,
			diagnosticRoot: diagnostics.rootDir,
			agentBin: process.env.AGENT_BIN,
			autopilotBin: process.env.AUTOPILOTAGENT_BIN,
			healthPort: healthServer.port,
			adapter: "worker",
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
					onMetric({ type: "queue", depth, oldestAgeMs: oldestAge });

					const attentionStats = await database.sql`
						SELECT
							count(*)::int AS pending,
							count(*) FILTER (
								WHERE state IN (
									'DEVELOPMENT_FAILED',
									'DEVELOPMENT_INTERRUPTED',
									'PR_CREATION_FAILED',
									'CI_FAILED',
									'BLOCKED'
								)
							)::int AS urgent
						FROM features
						WHERE archived_at IS NULL
							AND (
								state IN (
									'TASKS_REVIEW',
									'DEVELOPMENT_FAILED',
									'DEVELOPMENT_INTERRUPTED',
									'PR_CREATION_FAILED',
									'CI_FAILED',
									'PR_REVIEW',
									'PR_CHANGES_REQUESTED',
									'BLOCKED'
								)
							)
					`.catch(() => [{ pending: 0, urgent: 0 }]);
					onMetric({
						type: "attention",
						pending: Number(attentionStats[0]?.pending ?? 0),
						urgent: Number(attentionStats[0]?.urgent ?? 0),
					});

					logger.info("worker metrics", {
						workerId,
						activeJobs: supervisor.activeCount(),
						capacity: supervisor.capacity(),
						adapter: "worker",
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
							adapter: "worker",
						});
					}
					lastPrune = now;
				}
				await waitForAbort(signal, 1_000);
			}
		})();

		// Drain durable cancel commands and GitHub handoff/reconciliation
		// concurrently with development slots.
		const commandLoop = jobCommands.run(signal);
		const githubLoop = githubRuntime.run(signal);
		try {
			await Promise.all([
				supervisor.run(signal),
				commandLoop,
				githubLoop,
				background.catch(() => undefined),
			]);
		} finally {
			healthReady = false;
			healthServer.stop();
		}

		await database.sql`
			UPDATE worker_registrations SET stopped_at = now(), active_jobs = 0
			WHERE id = ${registration.id}
		`;
		logger.info("worker stopped", { workerId, adapter: "worker" });
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
		logger.error("worker stopped", { detail, adapter: "worker" });
		process.exit(1);
	});
}
