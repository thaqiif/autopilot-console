import { LoginRateLimiter } from "../../apps/api/src/auth/login-rate-limit";
import { createSessionService, type SessionService } from "../../apps/api/src/auth/session-service";
import {
	type ApiTestHarness,
	type Clock,
	createApiTestHarness,
} from "../../apps/api/src/testing/api-fixture";
import type { AutopilotRunner } from "../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createDatabaseClient,
	createDatabaseFixture,
	createWorkspace,
	type DatabaseClient,
	type DatabaseFixture,
	type Sql,
} from "../../packages/database/src/index";
import {
	createFeatureService,
	createProjectService,
	createReleaseService,
	createTaskApprovalService,
	type FeatureService,
	type ProjectService,
	type ReleaseService,
	type TaskApprovalService,
} from "../../packages/domain/src/index";
import type { GitGateway } from "../../packages/git/src/index";
import type { GitHubGateway } from "../../packages/github/src/index";
import {
	createFakeAutopilot,
	createFakeAutopilotState,
	createFakeGit,
	createFakeGitHub,
	createFakeGitHubState,
	createFakeGitState,
	type FakeAutopilotState,
	type FakeGitHubState,
	type FakeGitState,
} from "./fake-external-adapters";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg-local:5432/autopilot_console";

const ADMIN_USERNAME = "owner";
const ADMIN_PASSWORD = "Bootstrap-Passw0rd!";

export interface Phase1Context {
	sql: Sql;
	client: DatabaseClient;
	fixture: DatabaseFixture;
	clock: Clock;
	gitState: FakeGitState;
	githubState: FakeGitHubState;
	autopilotState: FakeAutopilotState;
	git: GitGateway;
	github: GitHubGateway;
	autopilot: AutopilotRunner;
	projectService: ProjectService;
	releaseService: ReleaseService;
	featureService: FeatureService;
	taskApprovalService: TaskApprovalService;
	sessionService: SessionService;
	api: ApiTestHarness;
}

export function createClock(initialIso = "2026-07-18T00:00:00.000Z"): Clock {
	let currentMs = Date.parse(initialIso);
	return {
		now: () => new Date(currentMs),
		advanceMs: (ms: number) => {
			currentMs += ms;
		},
	};
}

/** Truncate all domain tables for a clean test slate. Recreates workspace row. */
export async function truncateAll(sql: Sql): Promise<void> {
	await sql.unsafe(`
		TRUNCATE TABLE
			audit_events,
			activity_events,
			diagnostic_log_chunks,
			failure_records,
			progress_snapshots,
			outbox_intents,
			idempotency_records,
			development_job_attempts,
			scheduled_reconciliation_jobs,
			worker_registrations,
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
	await createWorkspace(sql);
}

/** Bootstrap a full Phase 1 test context with isolated state. */
export async function bootstrapPhase1(options?: {
	workspaceRoot?: string;
}): Promise<Phase1Context> {
	const client = createDatabaseClient(DATABASE_URL);
	const sql = client.sql;

	await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
	await sql.unsafe("CREATE SCHEMA public");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO postgres");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO public");
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
	await createWorkspace(sql);

	const clock = createClock();
	const gitState = createFakeGitState();
	const githubState = createFakeGitHubState();
	const autopilotState = createFakeAutopilotState();

	const git = createFakeGit({ state: gitState });
	const github = createFakeGitHub({ state: githubState });
	const autopilot = createFakeAutopilot({ state: autopilotState });

	const workspaceRoot = options?.workspaceRoot ?? "/workspaces";

	const projectService = createProjectService({
		sql,
		workspaceRoots: [workspaceRoot],
		git,
		github,
		autopilot,
		now: clock.now,
	});

	const releaseService = createReleaseService({ sql, now: clock.now });
	const featureService = createFeatureService({ sql, now: clock.now });
	const taskApprovalService = createTaskApprovalService({ sql, now: clock.now });

	const rateLimiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
	const sessionService = createSessionService({ sql, rateLimiter, now: clock.now });

	const api = await createApiTestHarness({
		sql,
		sessionService,
		now: clock.now,
		adapters: {
			sql,
			projectService,
			releaseService,
			featureService,
			taskApprovalService,
			cancelHandler: async () => ({ kind: "cancelled" }),
			retryHandler: async () => ({ kind: "retrying" }),
		},
	});

	await api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

	return {
		sql,
		client,
		fixture: createDatabaseFixture(sql),
		clock,
		gitState,
		githubState,
		autopilotState,
		git,
		github,
		autopilot,
		projectService,
		releaseService,
		featureService,
		taskApprovalService,
		sessionService,
		api,
	};
}

export { ADMIN_PASSWORD, ADMIN_USERNAME, DATABASE_URL };
