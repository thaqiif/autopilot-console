import { CliAutopilotRunner } from "../../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createDatabaseClient,
	createWorkspace,
} from "../../../packages/database/src/index";
import {
	createFeatureService,
	createProjectService,
	createReleaseService,
	createTaskApprovalService,
} from "../../../packages/domain/src/index";
import { CliGitGateway } from "../../../packages/git/src/index";
import { GhCliGateway } from "../../../packages/github/src/index";
import {
	createMetricsCollector,
	createStructuredLogger,
	loadRuntimeConfig,
	redactSecrets,
} from "../../../packages/shared/src/index";
import { createRetryService } from "../../worker/src/process/retry-service";
import { bootstrapAdministrator } from "./auth/admin-bootstrap";
import { createSessionService } from "./auth/session-service";
import type { HealthProbe } from "./health/health-service";
import { createServer } from "./server";

const logger = createStructuredLogger({
	baseContext: { service: "api" },
});
const metrics = createMetricsCollector();

export async function startApi() {
	const config = loadRuntimeConfig();
	const database = createDatabaseClient(config.database.url);
	try {
		await applyCoreMigration(database.sql);
		await applyWorkflowMigration(database.sql);
		await createWorkspace(database.sql);
		await bootstrapAdministrator(database.sql, {
			username: process.env.ADMIN_USERNAME?.trim() || "admin",
			bootstrapPassword: config.admin.bootstrapPassword,
		});

		const git = new CliGitGateway();
		const github = new GhCliGateway();
		const autopilot = new CliAutopilotRunner({ executablePath: process.env.AUTOPILOTAGENT_BIN });
		// Durable SQL-only retry: no Autopilot process probes in API request scope.
		// Queued cancel is durable in the route; running cancel is worker-owned.
		const retry = createRetryService({ sql: database.sql });
		const healthProbes = createProductionHealthProbes(database.sql, autopilot, github, metrics);
		const port = Number(process.env.PORT) || 3000;
		const server = createServer({
			port,
			nodeEnv: config.nodeEnv,
			sessionService: createSessionService({ sql: database.sql }),
			healthProbes,
			adapters: {
				sql: database.sql,
				projectService: createProjectService({
					sql: database.sql,
					workspaceRoots: config.workspace.roots,
					git,
					github,
					autopilot,
				}),
				releaseService: createReleaseService({ sql: database.sql }),
				featureService: createFeatureService({ sql: database.sql }),
				taskApprovalService: createTaskApprovalService({ sql: database.sql }),
				retryHandler: (request) => retry.retry(request),
			},
		});

		logger.info("api listening", {
			port,
			nodeEnv: config.nodeEnv,
			metrics: metrics.snapshot(),
		});

		let closing = false;
		const close = async () => {
			if (closing) return;
			closing = true;
			logger.info("api shutting down");
			server.stop();
			await database.end();
		};
		process.once("SIGTERM", () => void close());
		process.once("SIGINT", () => void close());
		return { server, database, close, logger, metrics };
	} catch (error) {
		await database.end();
		throw error;
	}
}

interface AutopilotHealthAdapter {
	validateRuntime(): Promise<{ ok: boolean }>;
}

interface GithubAuthenticationResult {
	ok: boolean;
	authenticated: boolean;
}

interface GithubAccessResult {
	ok: boolean;
	authenticated: boolean;
	repositoryReadable?: boolean;
}

interface GithubHealthAdapter {
	/** Session-level authentication check (no project/repository required). */
	validateAuthentication(): Promise<GithubAuthenticationResult>;
	/** Optional project repository access check. */
	validateAccess(input: {
		repository: { owner: string; repository: string; fullName: string };
		projectRoot: string;
	}): Promise<GithubAccessResult>;
}

type ProbeResult = { ok: boolean; detail: Record<string, unknown> };

/** Shape probe details to known boolean/number/string fields only — never adapter text. */
function shapeProbe(
	ok: boolean,
	detail: Record<string, boolean | number | string | null>,
): ProbeResult {
	return { ok, detail: { ...detail } };
}

function inactiveWorkerDetail(): ProbeResult {
	return shapeProbe(false, {
		active: false,
		capacity: 0,
		activeJobs: 0,
		availableSlots: 0,
		lastHeartbeatAt: null,
	});
}

function githubDetail(input: {
	ok: boolean;
	authenticated: boolean;
	projectAvailable: boolean;
	repositoryReadable?: boolean;
}): ProbeResult {
	const detail: Record<string, boolean | number | string | null> = {
		authenticated: input.authenticated,
		projectAvailable: input.projectAvailable,
	};
	if (input.repositoryReadable !== undefined) {
		detail.repositoryReadable = input.repositoryReadable;
	}
	return shapeProbe(input.ok, detail);
}

export function createProductionHealthProbes(
	sql: ReturnType<typeof createDatabaseClient>["sql"],
	autopilot: AutopilotHealthAdapter,
	github: GithubHealthAdapter,
	metricsCollector = metrics,
): { database: HealthProbe; worker: HealthProbe; autopilot: HealthProbe; github: HealthProbe } {
	return {
		database: {
			name: "database",
			check: async () => {
				try {
					await sql`SELECT 1`;
					return shapeProbe(true, { available: true });
				} catch {
					return shapeProbe(false, { available: false });
				}
			},
		},
		worker: {
			name: "worker",
			check: async () => {
				try {
					const rows = await sql`
						SELECT worker_id, hostname, capacity, active_jobs, last_heartbeat_at
						FROM worker_registrations
						WHERE stopped_at IS NULL AND last_heartbeat_at > now() - interval '30 seconds'
						ORDER BY last_heartbeat_at DESC LIMIT 1
					`;
					const worker = rows[0];
					if (!worker) {
						metricsCollector.setActiveJobs(0, 0);
						metricsCollector.setHeartbeatAge(Number.POSITIVE_INFINITY);
						return inactiveWorkerDetail();
					}
					const capacity = Number(worker.capacity);
					const activeJobs = Number(worker.active_jobs);
					const lastHeartbeatAt = worker.last_heartbeat_at as Date;
					const heartbeatAge = Math.max(0, Date.now() - lastHeartbeatAt.getTime());
					metricsCollector.setActiveJobs(activeJobs, capacity);
					metricsCollector.setHeartbeatAge(heartbeatAge);
					return shapeProbe(true, {
						active: true,
						capacity,
						activeJobs,
						availableSlots: Math.max(0, capacity - activeJobs),
						lastHeartbeatAt: lastHeartbeatAt.toISOString(),
						heartbeatAge,
					});
				} catch {
					metricsCollector.setActiveJobs(0, 0);
					metricsCollector.setHeartbeatAge(Number.POSITIVE_INFINITY);
					return inactiveWorkerDetail();
				}
			},
		},
		autopilot: {
			name: "autopilot",
			check: async () => {
				try {
					const result = await autopilot.validateRuntime();
					return shapeProbe(result.ok, { available: result.ok });
				} catch {
					return shapeProbe(false, { available: false });
				}
			},
		},
		github: {
			name: "github",
			check: async () => {
				// Always verify authentication, even when no project is registered.
				let authenticated = false;
				try {
					const auth = await github.validateAuthentication();
					authenticated = auth.authenticated === true && auth.ok === true;
				} catch {
					authenticated = false;
				}

				let project:
					| {
							github_owner: string;
							github_repo: string;
							canonical_path: string;
					  }
					| undefined;
				try {
					const [row] = await sql`
						SELECT github_owner, github_repo, canonical_path FROM projects
						WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1
					`;
					if (row) {
						project = {
							github_owner: row.github_owner as string,
							github_repo: row.github_repo as string,
							canonical_path: row.canonical_path as string,
						};
					}
				} catch {
					// Project lookup failure is not fatal for auth-only readiness.
					project = undefined;
				}

				if (!project) {
					return githubDetail({
						ok: authenticated,
						authenticated,
						projectAvailable: false,
					});
				}

				if (!authenticated) {
					metricsCollector.incrementAdapterError("github");
					return githubDetail({
						ok: false,
						authenticated: false,
						projectAvailable: true,
						repositoryReadable: false,
					});
				}

				const owner = project.github_owner;
				const repository = project.github_repo;
				try {
					const result = await github.validateAccess({
						repository: { owner, repository, fullName: `${owner}/${repository}` },
						projectRoot: project.canonical_path,
					});
					const repositoryReadable = result.repositoryReadable === true && result.ok === true;
					if (!result.ok || !repositoryReadable) {
						metricsCollector.incrementAdapterError("github");
					}
					return githubDetail({
						ok: result.ok && repositoryReadable,
						authenticated: result.authenticated === true,
						projectAvailable: true,
						repositoryReadable,
					});
				} catch {
					metricsCollector.incrementAdapterError("github");
					return githubDetail({
						ok: false,
						authenticated: true,
						projectAvailable: true,
						repositoryReadable: false,
					});
				}
			},
		},
	};
}

if (import.meta.main) {
	startApi().catch((error) => {
		const detail = error instanceof Error ? redactSecrets(error.message) : "unknown startup error";
		logger.error("api startup failed", { detail });
		process.exit(1);
	});
}
