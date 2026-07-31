import { LoginRateLimiter } from "../../apps/api/src/auth/login-rate-limit";
import { createSessionService, type SessionService } from "../../apps/api/src/auth/session-service";
import {
	type ApiTestHarness,
	type Clock,
	createApiTestHarness,
} from "../../apps/api/src/testing/api-fixture";
import {
	createDevelopmentWorker,
	createPostgresPrHandoffStore,
	createPostgresPrReconciliationStore,
	createPRHandoffWorker,
	createPRReconciliationWorker,
	type DevelopmentWorkerOutcome,
	type PRHandoffOutcome,
} from "../../apps/worker/src/index";
import type { AutopilotRunner } from "../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createApiCompatibleClock,
	createDatabaseClient,
	createDatabaseFixture,
	createDevelopmentQueue,
	createWorkerRegistration,
	createWorkspace,
	type DatabaseClient,
	type DatabaseFixture,
	type DevelopmentQueue,
	resetSchema,
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
import type { GitHubGateway, RepositoryRef } from "../../packages/github/src/index";
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
	mergePrExternally as mergeFakePrExternally,
} from "./fake-external-adapters";

const DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console";

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
	queue: DevelopmentQueue;
	workerId: string;
	workerRegistrationId: string;
	/** Re-register the development worker after truncateAll wipes registrations. */
	ensureWorkerRegistration: () => Promise<void>;
	runDevelopmentOnce: () => Promise<DevelopmentWorkerOutcome>;
	runPrHandoff: (attemptId: string) => Promise<PRHandoffOutcome>;
	pollPullRequests: (repository: RepositoryRef) => Promise<number>;
	mergePrExternally: (prNumber: number, mergeCommitSha: string) => void;
}

/** Re-export shared clock for backward compat. Prefer createApiCompatibleClock directly. */
export const createClock = createApiCompatibleClock;

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

	await resetSchema(sql);
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

	const workerId = `phase1-worker-${crypto.randomUUID()}`;
	let workerRegistrationId = (
		await createWorkerRegistration(sql, {
			workerId,
			hostname: "phase1-test-host",
			capacity: 4,
		})
	).id;
	const queue = createDevelopmentQueue(sql, {
		maxConcurrent: 4,
		clock: clock.now,
	});
	const ensureWorkerRegistration = async () => {
		const existing = await sql`
			SELECT id FROM worker_registrations
			WHERE worker_id = ${workerId} AND stopped_at IS NULL
			LIMIT 1
		`;
		if (existing[0]) {
			workerRegistrationId = existing[0].id as string;
			return;
		}
		workerRegistrationId = (
			await createWorkerRegistration(sql, {
				workerId,
				hostname: "phase1-test-host",
				capacity: 4,
			})
		).id;
	};
	const developmentWorker = createDevelopmentWorker({
		sql,
		queue,
		git,
		autopilot,
		workerId,
		// Read current registration id on each call path through a getter store identity.
		get workerRegistrationId() {
			return workerRegistrationId;
		},
		heartbeatScheduler: {
			async run(_intervalMs, heartbeat, task) {
				await heartbeat();
				return task();
			},
		},
		now: clock.now,
	} as Parameters<typeof createDevelopmentWorker>[0]);
	const prHandoffWorker = createPRHandoffWorker({
		store: createPostgresPrHandoffStore(sql, clock.now),
		git,
		github,
		workerId,
		now: clock.now,
	});

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
		queue,
		workerId,
		get workerRegistrationId() {
			return workerRegistrationId;
		},
		ensureWorkerRegistration,
		runDevelopmentOnce: async () => {
			await ensureWorkerRegistration();
			return developmentWorker.runOnce();
		},
		runPrHandoff: (attemptId) => prHandoffWorker.handoff(attemptId),
		pollPullRequests: async (repository) => {
			const worker = createPRReconciliationWorker({
				store: createPostgresPrReconciliationStore({ sql, now: clock.now }),
				github,
				repository,
				now: clock.now,
			});
			return worker.pollAll();
		},
		mergePrExternally: (prNumber, mergeCommitSha) => {
			mergeFakePrExternally(githubState, prNumber, mergeCommitSha);
		},
	};
}

export { ADMIN_PASSWORD, ADMIN_USERNAME, DATABASE_URL };
