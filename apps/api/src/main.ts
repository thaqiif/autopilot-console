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
import { loadRuntimeConfig, redactSecrets } from "../../../packages/shared/src/index";
import { createCancellationController } from "../../worker/src/process/cancellation-controller";
import { createProcessTreeInspector } from "../../worker/src/process/process-tree";
import { createRetryService } from "../../worker/src/process/retry-service";
import { bootstrapAdministrator } from "./auth/admin-bootstrap";
import { createSessionService } from "./auth/session-service";
import type { HealthProbe } from "./health/health-service";
import { createServer } from "./server";

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
		const cancellation = createCancellationController({
			sql: database.sql,
			tree: createProcessTreeInspector(),
		});
		const retry = createRetryService({ sql: database.sql, autopilot });
		const healthProbes = createProductionHealthProbes(database.sql, autopilot, github);
		const server = createServer({
			port: Number(process.env.PORT) || 3000,
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
				cancelHandler: (attempt, feature, reason, operationId) =>
					attempt.status === "QUEUED"
						? cancellation.cancelQueued(attempt, feature, reason, operationId)
						: Promise.resolve({
								kind: "blocked",
								attemptId: attempt.id,
								reason: "Running cancellation must be performed by the owning worker.",
							}),
				retryHandler: (request) => retry.retry(request),
			},
		});

		let closing = false;
		const close = async () => {
			if (closing) return;
			closing = true;
			server.stop();
			await database.end();
		};
		process.once("SIGTERM", () => void close());
		process.once("SIGINT", () => void close());
		return { server, database, close };
	} catch (error) {
		await database.end();
		throw error;
	}
}

interface AutopilotHealthAdapter {
	validateRuntime(): Promise<{ ok: boolean }>;
}

interface GithubHealthAdapter {
	validateAccess(input: {
		repository: { owner: string; repository: string; fullName: string };
		projectRoot: string;
	}): Promise<{ ok: boolean; authenticated: boolean }>;
}

export function createProductionHealthProbes(
	sql: ReturnType<typeof createDatabaseClient>["sql"],
	autopilot: AutopilotHealthAdapter,
	github: GithubHealthAdapter,
): { database: HealthProbe; worker: HealthProbe; autopilot: HealthProbe; github: HealthProbe } {
	return {
		database: {
			name: "database",
			check: async () => {
				await sql`SELECT 1`;
				return { ok: true };
			},
		},
		worker: {
			name: "worker",
			check: async () => {
				const rows = await sql`
					SELECT worker_id, hostname, capacity, active_jobs, last_heartbeat_at
					FROM worker_registrations
					WHERE stopped_at IS NULL AND last_heartbeat_at > now() - interval '30 seconds'
					ORDER BY last_heartbeat_at DESC LIMIT 1
				`;
				const worker = rows[0];
				if (!worker) {
					return {
						ok: false,
						detail: {
							active: false,
							capacity: 0,
							activeJobs: 0,
							availableSlots: 0,
							lastHeartbeatAt: null,
						},
					};
				}
				const capacity = Number(worker.capacity);
				const activeJobs = Number(worker.active_jobs);
				return {
					ok: true,
					detail: {
						active: true,
						capacity,
						activeJobs,
						availableSlots: Math.max(0, capacity - activeJobs),
						lastHeartbeatAt: (worker.last_heartbeat_at as Date).toISOString(),
					},
				};
			},
		},
		autopilot: {
			name: "autopilot",
			check: async () => {
				const result = await autopilot.validateRuntime();
				return { ok: result.ok, detail: { available: result.ok } };
			},
		},
		github: {
			name: "github",
			check: async () => {
				const [project] = await sql`
					SELECT github_owner, github_repo, canonical_path FROM projects
					WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1
				`;
				if (!project) return { ok: true, detail: { configured: true, projectAvailable: false } };
				const owner = project.github_owner as string;
				const repository = project.github_repo as string;
				const result = await github.validateAccess({
					repository: { owner, repository, fullName: `${owner}/${repository}` },
					projectRoot: project.canonical_path as string,
				});
				return { ok: result.ok, detail: { authenticated: result.authenticated } };
			},
		},
	};
}

if (import.meta.main) {
	startApi().catch((error) => {
		const detail = error instanceof Error ? redactSecrets(error.message) : "unknown startup error";
		console.error(`API startup failed: ${detail}`);
		process.exit(1);
	});
}
