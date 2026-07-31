import { LoginRateLimiter } from "../../apps/api/src/auth/login-rate-limit";
import { createSessionService, type SessionService } from "../../apps/api/src/auth/session-service";
import {
	type ApiTestHarness,
	type Clock,
	createApiTestHarness,
} from "../../apps/api/src/testing/api-fixture";
import {
	createConcurrentDevelopmentWorkerRuntime,
	createDevelopmentWorker,
	createGithubRuntime,
	type DevelopmentWorker,
	type DevelopmentWorkerOutcome,
	type GithubRuntime,
	type WorkerRuntime,
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
	heartbeatWorker,
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
import type { GitHubGateway, PullRequestStatus } from "../../packages/github/src/index";
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
	setPullRequestStatus as setFakePullRequestStatus,
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
	/** Production concurrent development supervisor (apps/worker main composition). */
	developmentRuntime: WorkerRuntime;
	/** Production GitHub handoff + reconciliation runtime (apps/worker main composition). */
	githubRuntime: GithubRuntime;
	/** Re-register the development worker after truncateAll wipes registrations. */
	ensureWorkerRegistration: () => Promise<void>;
	/**
	 * Drain free capacity through the production supervisor path until the queue
	 * is idle. Collects completed slot outcomes without bypassing ownership.
	 */
	drainDevelopmentWork: () => Promise<DevelopmentWorkerOutcome[]>;
	mergePrExternally: (prNumber: number, mergeCommitSha: string) => void;
	setPullRequestStatus: (
		prNumber: number,
		status: Partial<PullRequestStatus> & { state?: PullRequestStatus["state"] },
	) => void;
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
	/** Concurrent development capacity (mirrors WORKER_MAX_CONCURRENT_JOBS). */
	capacity?: number;
}): Promise<Phase1Context> {
	const client = createDatabaseClient(DATABASE_URL);
	const sql = client.sql;
	const capacity = Math.max(1, options?.capacity ?? 4);

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
			// Production API only persists cancel/retry intents — no process effects.
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
			capacity,
		})
	).id;

	const queue = createDevelopmentQueue(sql, {
		maxConcurrent: capacity,
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
				capacity,
			})
		).id;
	};

	// Same DevelopmentWorker + concurrent supervisor composition as apps/worker main.
	const developmentWorker = createDevelopmentWorker({
		sql,
		queue,
		git,
		autopilot,
		workerId,
		get workerRegistrationId() {
			return workerRegistrationId;
		},
		// Tests use a synchronous heartbeat scheduler so Autopilot wait completes
		// without wall-clock polling while still running under the production path.
		heartbeatScheduler: {
			async run(_intervalMs, heartbeat, task) {
				await heartbeat();
				return task();
			},
		},
		now: clock.now,
	} as Parameters<typeof createDevelopmentWorker>[0]);

	// Production concurrent supervisor with outcome capture for assertions.
	const collectedOutcomes: DevelopmentWorkerOutcome[] = [];
	const instrumentedWorker: DevelopmentWorker = {
		runOnce: () => developmentWorker.runOnce(),
		beginOnce: async () => {
			const begun = await developmentWorker.beginOnce();
			if (begun.kind === "idle") return begun;
			return {
				kind: "started",
				attemptId: begun.attemptId,
				finished: begun.finished.then((outcome) => {
					collectedOutcomes.push(outcome);
					return outcome;
				}),
			};
		},
	};
	const developmentRuntime = createConcurrentDevelopmentWorkerRuntime({
		capacity,
		worker: instrumentedWorker,
		heartbeatIntervalMs: 10_000,
		idlePollMs: 1,
		// Instant sleep so drain loops are deterministic in tests.
		sleep: async () => undefined,
		heartbeat: async (activeJobs) => {
			await ensureWorkerRegistration();
			await heartbeatWorker(sql, workerRegistrationId, { activeJobs });
		},
	});

	// Same GitHub runtime composition as apps/worker main (outbox consumer + poller).
	const githubRuntime = createGithubRuntime({
		sql,
		git,
		github,
		workerId,
		pollIntervalMs: 60_000,
		handoffPollIntervalMs: 1,
		now: clock.now,
		sleep: async () => undefined,
	});

	/**
	 * Drive the production supervisor until the queue is idle and all in-flight
	 * ownership has drained. Returns the actual worker slot outcomes.
	 */
	const drainDevelopmentWork = async (): Promise<DevelopmentWorkerOutcome[]> => {
		await ensureWorkerRegistration();
		collectedOutcomes.length = 0;
		const controller = new AbortController();
		const finished = developmentRuntime.run(controller.signal);

		for (let i = 0; i < 50; i += 1) {
			const depth = await sql`
				SELECT count(*)::int AS n FROM development_job_attempts
				WHERE status = 'QUEUED'
			`;
			const queued = Number(depth[0]?.n ?? 0);
			if (queued === 0 && developmentRuntime.activeCount() === 0) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		controller.abort();
		await finished;
		return [...collectedOutcomes];
	};

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
		developmentRuntime,
		githubRuntime,
		ensureWorkerRegistration,
		drainDevelopmentWork,
		mergePrExternally: (prNumber, mergeCommitSha) => {
			mergeFakePrExternally(githubState, prNumber, mergeCommitSha);
		},
		setPullRequestStatus: (prNumber, status) => {
			setFakePullRequestStatus(githubState, prNumber, status);
		},
	};
}

export { ADMIN_PASSWORD, ADMIN_USERNAME, DATABASE_URL };
