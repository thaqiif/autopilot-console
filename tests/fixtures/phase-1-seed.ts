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
	reconcileOrphansAtWorkerStartup,
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
	createHoldGate,
	type FakeAutopilotState,
	type FakeGitHubState,
	type FakeGitState,
	type HoldGate,
	mergePrExternally as mergeFakePrExternally,
	setPullRequestStatus as setFakePullRequestStatus,
} from "./fake-external-adapters";

const DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console";

const ADMIN_USERNAME = "owner";
const ADMIN_PASSWORD = "Bootstrap-Passw0rd!";

export interface Phase1HoldGates {
	/** Pause Autopilot wait so a RUNNING attempt owns a live supervisor slot. */
	autopilotWait: HoldGate;
	/** Pause git.pushFeatureBranch at the handoff push boundary. */
	gitPush: HoldGate;
	/** Pause github.createPullRequest at the PR-create boundary. */
	createPr: HoldGate;
	/** Pause github.getPullRequestStatus at the poll boundary. */
	githubPoll: HoldGate;
}

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
	/** Generation counter bumped on every API/worker/github component replacement. */
	lifecycleGeneration: {
		api: number;
		development: number;
		github: number;
	};
	/** Controllable external-effect hold gates for restart boundary tests. */
	holds: Phase1HoldGates;
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
	/**
	 * Dispose the current API harness and recreate it against the same database,
	 * session store, and domain services. Models an API process restart.
	 */
	restartApi: () => Promise<{ previousGeneration: number; generation: number }>;
	/**
	 * Abort any in-process development supervisor, optionally expire leases +
	 * run startup orphan reconciliation, then recreate the development worker
	 * runtime against the same database. Models a worker process restart.
	 */
	restartDevelopmentWorker: (options?: {
		expireLeases?: boolean;
		reconcileOrphans?: boolean;
	}) => Promise<{
		previousGeneration: number;
		generation: number;
		reconciled: number;
	}>;
	/**
	 * Recreate the GitHub runtime (handoff + poll) against the same database and
	 * adapter state. Models a worker restart mid push/PR-create/poll.
	 */
	restartGithubRuntime: () => Promise<{ previousGeneration: number; generation: number }>;
	/**
	 * Start the production development supervisor in the background and track
	 * its AbortController so restarts/afterEach can dispose it.
	 */
	startDevelopmentSupervisor: () => { stop: () => Promise<void> };
	/** Abort any tracked development supervisor without recreating the runtime. */
	stopDevelopmentSupervisor: () => Promise<void>;
	/** Clear mutable fake Git/GitHub/Autopilot effect logs between tests. */
	resetExternalAdapterState: () => void;
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

	const holds: Phase1HoldGates = {
		autopilotWait: createHoldGate(),
		gitPush: createHoldGate(),
		createPr: createHoldGate(),
		githubPoll: createHoldGate(),
	};

	// Mutable adapter handles so restart helpers rebuild runtimes against the same holds.
	let git: GitGateway = createFakeGit({ state: gitState, pushHold: holds.gitPush });
	let github: GitHubGateway = createFakeGitHub({
		state: githubState,
		createPrHold: holds.createPr,
		pollHold: holds.githubPoll,
	});
	let autopilot: AutopilotRunner = createFakeAutopilot({
		state: autopilotState,
		waitHold: holds.autopilotWait,
	});

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
	let sessionService = createSessionService({ sql, rateLimiter, now: clock.now });

	let api = await createApiTestHarness({
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

	let workerId = `phase1-worker-${crypto.randomUUID()}`;
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
		// worker_id is globally unique (including stopped rows). If this id was
		// previously registered, allocate a fresh process identity.
		const prior = await sql`
			SELECT id FROM worker_registrations WHERE worker_id = ${workerId} LIMIT 1
		`;
		if (prior[0]) {
			workerId = `phase1-worker-${crypto.randomUUID()}`;
		}
		workerRegistrationId = (
			await createWorkerRegistration(sql, {
				workerId,
				hostname: "phase1-test-host",
				capacity,
			})
		).id;
	};

	const lifecycleGeneration = {
		api: 1,
		development: 1,
		github: 1,
	};

	// Production concurrent supervisor with outcome capture for assertions.
	const collectedOutcomes: DevelopmentWorkerOutcome[] = [];
	let developmentAbort: AbortController | null = null;
	let developmentRuntime: WorkerRuntime;
	let githubRuntime: GithubRuntime;

	const buildDevelopmentRuntime = (): WorkerRuntime => {
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

		return createConcurrentDevelopmentWorkerRuntime({
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
	};

	const buildGithubRuntime = (): GithubRuntime =>
		createGithubRuntime({
			sql,
			git,
			github,
			workerId,
			pollIntervalMs: 60_000,
			handoffPollIntervalMs: 1,
			now: clock.now,
			sleep: async () => undefined,
		});

	// Same DevelopmentWorker + concurrent supervisor composition as apps/worker main.
	developmentRuntime = buildDevelopmentRuntime();
	// Same GitHub runtime composition as apps/worker main (outbox consumer + poller).
	githubRuntime = buildGithubRuntime();

	/**
	 * Drive the production supervisor until the queue is idle and all in-flight
	 * ownership has drained. Returns the actual worker slot outcomes.
	 */
	const drainDevelopmentWork = async (): Promise<DevelopmentWorkerOutcome[]> => {
		await ensureWorkerRegistration();
		collectedOutcomes.length = 0;
		const controller = new AbortController();
		developmentAbort = controller;
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
		if (developmentAbort === controller) developmentAbort = null;
		return [...collectedOutcomes];
	};

	const restartApi = async () => {
		const previousGeneration = lifecycleGeneration.api;
		// Recreate session service + Hono app against the same SQL and domain services.
		const rateLimiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
		const nextSession = createSessionService({ sql, rateLimiter, now: clock.now });
		const nextApi = await createApiTestHarness({
			sql,
			sessionService: nextSession,
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
		sessionService = nextSession;
		api = nextApi;
		lifecycleGeneration.api += 1;
		return { previousGeneration, generation: lifecycleGeneration.api };
	};

	const restartDevelopmentWorker = async (options?: {
		expireLeases?: boolean;
		reconcileOrphans?: boolean;
	}) => {
		const previousGeneration = lifecycleGeneration.development;
		// Dispose the previous supervisor loop if one is still running.
		if (developmentAbort && !developmentAbort.signal.aborted) {
			developmentAbort.abort();
		}
		developmentAbort = null;

		// Abandon in-flight Autopilot waits owned by the disposed process so they
		// cannot later persistSuccess after ownership has moved or been interrupted.
		holds.autopilotWait.abandonAll();
		// Restarted process can own new waits after the previous process is gone.
		holds.autopilotWait.disable();

		if (options?.expireLeases) {
			// Force ownership expiry so startup reconciliation sees orphaned work.
			const expiredAt = new Date(clock.now().getTime() - 60_000);
			const heartbeatPast = new Date(clock.now().getTime() - 90_000);
			await sql`
				UPDATE development_job_attempts
				SET lease_expires_at = ${expiredAt},
				    heartbeat_at = ${heartbeatPast}
				WHERE status IN ('RUNNING', 'CANCEL_REQUESTED')
			`;
		}

		let reconciled = 0;
		if (options?.reconcileOrphans !== false) {
			// Default: run the same startup reconciler as apps/worker main.
			reconciled = await reconcileOrphansAtWorkerStartup(sql, { now: clock.now });
		}

		// Stop previous registration and create a new worker identity.
		// worker_id is unique, so a restarted process must not reuse the stopped row.
		await sql`
			UPDATE worker_registrations
			SET stopped_at = ${clock.now()}
			WHERE worker_id = ${workerId} AND stopped_at IS NULL
		`;
		// Always allocate a never-before-seen worker_id (unique even for stopped rows).
		for (let attempt = 0; attempt < 5; attempt += 1) {
			workerId = `phase1-worker-${crypto.randomUUID()}`;
			try {
				workerRegistrationId = (
					await createWorkerRegistration(sql, {
						workerId,
						hostname: "phase1-test-host-restarted",
						capacity,
					})
				).id;
				break;
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code !== "23505" || attempt === 4) throw error;
			}
		}

		// Rebuild adapters so the new process has distinct object identity.
		git = createFakeGit({ state: gitState, pushHold: holds.gitPush });
		autopilot = createFakeAutopilot({
			state: autopilotState,
			waitHold: holds.autopilotWait,
		});
		// Domain services keep the same sql; project/git adapters used by worker only.
		developmentRuntime = buildDevelopmentRuntime();
		lifecycleGeneration.development += 1;
		return {
			previousGeneration,
			generation: lifecycleGeneration.development,
			reconciled,
		};
	};

	const resetExternalAdapterState = () => {
		gitState.preflightResults.clear();
		gitState.branches.clear();
		gitState.pushes.length = 0;
		gitState.commits.clear();
		githubState.prs.clear();
		githubState.statuses.clear();
		githubState.accessResults.clear();
		githubState.nextPrNumber = 1;
		autopilotState.runs.clear();
		autopilotState.results.clear();
		autopilotState.progress.clear();
		holds.autopilotWait.disable();
		holds.gitPush.disable();
		holds.createPr.disable();
		holds.githubPoll.disable();
	};

	const stopDevelopmentSupervisor = async () => {
		if (developmentAbort && !developmentAbort.signal.aborted) {
			developmentAbort.abort();
		}
		developmentAbort = null;
	};

	const startDevelopmentSupervisor = () => {
		// Replace any previous tracked supervisor synchronously by aborting first.
		if (developmentAbort && !developmentAbort.signal.aborted) {
			developmentAbort.abort();
		}
		const controller = new AbortController();
		developmentAbort = controller;
		const finished = developmentRuntime.run(controller.signal);
		return {
			stop: async () => {
				if (!controller.signal.aborted) controller.abort();
				await finished.catch(() => undefined);
				if (developmentAbort === controller) developmentAbort = null;
			},
		};
	};

	const restartGithubRuntime = async () => {
		const previousGeneration = lifecycleGeneration.github;
		// Abandon in-flight push/PR/poll effects owned by the disposed runtime process.
		// Shared adapter state still records completed effects exactly once.
		holds.gitPush.abandonAll();
		holds.createPr.abandonAll();
		holds.githubPoll.abandonAll();

		// Requeue claimed-but-incomplete create_pr intents so the recreated
		// runtime can finish exactly-once handoff after process replacement.
		await sql`
			UPDATE outbox_intents
			SET
				status = 'pending',
				claimed_by = NULL,
				claimed_at = NULL,
				completed_at = NULL,
				last_error = NULL,
				updated_at = now()
			WHERE status = 'claimed'
				AND kind = 'create_pr'
		`;

		// Rebuild gateways against the same mutable states/holds so effects stay singular.
		git = createFakeGit({ state: gitState, pushHold: holds.gitPush });
		github = createFakeGitHub({
			state: githubState,
			createPrHold: holds.createPr,
			pollHold: holds.githubPoll,
		});
		githubRuntime = buildGithubRuntime();
		lifecycleGeneration.github += 1;
		return { previousGeneration, generation: lifecycleGeneration.github };
	};

	return {
		sql,
		client,
		fixture: createDatabaseFixture(sql),
		clock,
		gitState,
		githubState,
		autopilotState,
		get git() {
			return git;
		},
		get github() {
			return github;
		},
		get autopilot() {
			return autopilot;
		},
		projectService,
		releaseService,
		featureService,
		taskApprovalService,
		get sessionService() {
			return sessionService;
		},
		get api() {
			return api;
		},
		queue,
		get workerId() {
			return workerId;
		},
		get workerRegistrationId() {
			return workerRegistrationId;
		},
		lifecycleGeneration,
		holds,
		get developmentRuntime() {
			return developmentRuntime;
		},
		get githubRuntime() {
			return githubRuntime;
		},
		ensureWorkerRegistration,
		drainDevelopmentWork,
		restartApi,
		restartDevelopmentWorker,
		restartGithubRuntime,
		startDevelopmentSupervisor,
		stopDevelopmentSupervisor,
		resetExternalAdapterState,
		mergePrExternally: (prNumber, mergeCommitSha) => {
			mergeFakePrExternally(githubState, prNumber, mergeCommitSha);
		},
		setPullRequestStatus: (prNumber, status) => {
			setFakePullRequestStatus(githubState, prNumber, status);
		},
	};
}

export { ADMIN_PASSWORD, ADMIN_USERNAME, DATABASE_URL };
