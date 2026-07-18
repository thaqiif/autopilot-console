import { describe, expect, test } from "bun:test";
import type {
	AutopilotRunHandle,
	AutopilotRunner,
	NormalizedRunResult,
	ProgressSnapshot,
} from "../../../../packages/autopilot/src/index";
import type {
	DevelopmentAttemptRow,
	DevelopmentQueue,
	FeatureRow,
	ProjectRow,
	TaskApprovalRow,
} from "../../../../packages/database/src/index";
import type {
	EnsureFeatureBranchRequest,
	GitGateway,
	GitPreflightRequest,
} from "../../../../packages/git/src/index";
import {
	createDevelopmentWorker,
	type DevelopmentWorker,
	type HeartbeatScheduler,
} from "./development-worker";
import type { DevelopmentFailureInput, DevelopmentWorkerStore } from "./development-worker-store";

const NOW = new Date("2026-07-18T16:00:00.000Z");

function progress(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
	return {
		total: 2,
		passed: 2,
		stuck: 0,
		invalidTest: 0,
		remaining: 0,
		allPass: true,
		blockedReasons: [],
		...overrides,
	};
}

function runResult(overrides: Partial<NormalizedRunResult> = {}): NormalizedRunResult {
	return {
		exitCode: 0,
		signal: null,
		outcome: "succeeded",
		allPass: true,
		progress: progress(),
		stdoutDiagnostic: "done",
		stderrDiagnostic: "",
		redactedMessage: "Autopilot run succeeded",
		...overrides,
	};
}

interface SeededExecution {
	attempt: DevelopmentAttemptRow;
	project: ProjectRow;
	feature: FeatureRow;
	approval: TaskApprovalRow;
	workerId: string;
	workerRegistrationId: string;
}

function seedExecution(
	options: { retry?: boolean; processIdentity?: boolean } = {},
): SeededExecution {
	const projectId = crypto.randomUUID();
	const featureId = crypto.randomUUID();
	const approvalId = crypto.randomUUID();
	const attemptId = crypto.randomUUID();
	const branchName = `feature/${featureId}-login`;
	const project: ProjectRow = {
		id: projectId,
		workspaceId: crypto.randomUUID(),
		name: "Project A",
		slug: "project-a",
		description: null,
		githubOwner: "acme",
		githubRepo: "project-a",
		canonicalPath: "/workspaces/project-a",
		developmentBranch: "main",
		validationStatus: "valid",
		lastValidatedAt: NOW,
		status: "active",
		archivedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
	};
	const feature: FeatureRow = {
		id: featureId,
		projectId,
		releaseId: crypto.randomUUID(),
		slug: "login",
		title: "Login",
		summary: null,
		state: "QUEUED",
		branchName,
		taskPath: "docs/tasks/login.json",
		rowVersion: 4,
		archivedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
	};
	const approval: TaskApprovalRow = {
		id: approvalId,
		projectId,
		featureId,
		relativeTaskPath: "docs/tasks/login.json",
		checksum: "sha256:approved",
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [{ id: "1", passes: false }] },
		approvedByAdminId: crypto.randomUUID(),
		approvedAt: NOW,
		invalidatedAt: null,
		createdAt: NOW,
	};
	const workerRegistrationId = crypto.randomUUID();
	const attempt: DevelopmentAttemptRow = {
		id: attemptId,
		projectId,
		featureId,
		taskApprovalId: approvalId,
		branchName,
		operationKey: `develop:${attemptId}`,
		status: "QUEUED",
		predecessorAttemptId: options.retry ? crypto.randomUUID() : null,
		workerRegistrationId: null,
		processPid: options.processIdentity ? 9999 : null,
		processStartIdentity: options.processIdentity ? "reused-pid" : null,
		leaseExpiresAt: null,
		heartbeatAt: null,
		enqueuedAt: NOW,
		startedAt: null,
		endedAt: null,
		exitCode: null,
		cancellationRequestedAt: null,
		cancellationReason: null,
		structuredResult: null,
		createdAt: NOW,
		updatedAt: NOW,
	};
	return {
		attempt,
		project,
		feature,
		approval,
		workerId: `worker-${crypto.randomUUID()}`,
		workerRegistrationId,
	};
}

class FakeDevelopmentStore implements DevelopmentWorkerStore {
	readonly events: string[];
	readonly seed: SeededExecution;
	heartbeats = 0;
	outboxIntents = 0;
	activityTypes: string[] = [];
	failures: DevelopmentFailureInput[] = [];

	constructor(seed: SeededExecution, events: string[]) {
		this.seed = structuredClone(seed);
		this.events = events;
	}

	async getAttempt(attemptId: string) {
		return attemptId === this.seed.attempt.id ? structuredClone(this.seed.attempt) : null;
	}

	async loadContext() {
		this.events.push("store.load-context");
		return structuredClone({
			attempt: this.seed.attempt,
			project: this.seed.project,
			feature: this.seed.feature,
			approval: this.seed.approval,
		});
	}

	async markDeveloping() {
		this.events.push("store.mark-developing");
		this.seed.feature.state = "DEVELOPING";
		this.seed.feature.rowVersion += 1;
		this.activityTypes.push("development.started");
	}

	async persistProcessIdentity(
		_attemptId: string,
		input: Parameters<DevelopmentWorkerStore["persistProcessIdentity"]>[1],
	) {
		this.events.push("store.persist-process-identity");
		this.seed.attempt.processPid = input.handle.processIdentity.pid;
		this.seed.attempt.processStartIdentity = String(input.handle.processIdentity.startTimeMs);
		this.seed.attempt.heartbeatAt = input.heartbeatAt;
		this.seed.attempt.leaseExpiresAt = input.leaseExpiresAt;
	}

	async heartbeat() {
		this.events.push("store.heartbeat");
		this.heartbeats += 1;
	}

	async persistSuccess(
		_attemptId: string,
		input: Parameters<DevelopmentWorkerStore["persistSuccess"]>[1],
	) {
		this.events.push("store.persist-success");
		this.seed.attempt.status = "SUCCEEDED";
		this.seed.attempt.exitCode = input.result.exitCode;
		this.seed.attempt.structuredResult = input.result;
		this.seed.feature.state = "DEVELOPMENT_COMPLETE";
		this.outboxIntents += 1;
		this.activityTypes.push("development.completed");
	}

	async persistFailure(input: DevelopmentFailureInput) {
		this.events.push("store.persist-failure");
		this.failures.push(input);
		this.seed.attempt.status = "FAILED";
		this.seed.attempt.structuredResult = input.structuredResult ?? {
			failureKind: input.failureKind,
		};
		this.seed.feature.state = input.targetState;
		this.activityTypes.push(
			input.targetState === "BLOCKED" ? "development.blocked" : "development.failed",
		);
	}
}

class TargetedQueue implements DevelopmentQueue {
	readonly seed: SeededExecution;
	readonly claimedOverride?: DevelopmentAttemptRow;

	constructor(seed: SeededExecution, claimedOverride?: DevelopmentAttemptRow) {
		this.seed = seed;
		this.claimedOverride = claimedOverride;
	}

	async claimNextAttempt(workerId: string) {
		if (workerId !== this.seed.workerId || this.seed.attempt.status !== "QUEUED") return null;
		this.seed.attempt.status = "RUNNING";
		this.seed.attempt.workerRegistrationId = this.seed.workerRegistrationId;
		this.seed.attempt.startedAt = NOW;
		this.seed.attempt.heartbeatAt = NOW;
		return { attempt: structuredClone(this.claimedOverride ?? this.seed.attempt) };
	}
}

class FakeGitGateway implements GitGateway {
	readonly events: string[];
	preflightRequest: GitPreflightRequest | null = null;
	branchRequest: EnsureFeatureBranchRequest | null = null;
	preflightOk = true;

	constructor(events: string[]) {
		this.events = events;
	}

	async preflight(request: GitPreflightRequest) {
		this.events.push("git.preflight");
		this.preflightRequest = request;
		return {
			ok: this.preflightOk,
			projectRoot: request.projectRoot,
			remoteName: request.remoteName,
			remoteUrl: "https://github.com/acme/project-a.git",
			repository: request.expectedRepository,
			developmentBranch: request.developmentBranch,
			featureBranch: request.featureBranch,
			headBranch: request.featureBranch,
			headSha: "abc123",
			failures: this.preflightOk
				? []
				: [{ code: "DIRTY_WORKTREE" as const, message: "unrelated changes" }],
		};
	}

	async ensureFeatureBranch(request: EnsureFeatureBranchRequest) {
		this.events.push("git.ensure-branch");
		this.branchRequest = request;
		return {
			featureBranch: request.featureBranch,
			created: request.createIfMissing,
			headSha: "abc123",
		};
	}

	async observeCommits() {
		return [];
	}

	async pushFeatureBranch(
		_request: Parameters<GitGateway["pushFeatureBranch"]>[0],
	): Promise<never> {
		throw new Error("push is not part of development execution");
	}
}

class FakeAutopilotRunner implements AutopilotRunner {
	readonly events: string[];
	readonly store: FakeDevelopmentStore;
	result = runResult();
	taskChecksum = "sha256:approved";
	startCalls = 0;
	throwOnWait: Error | null = null;

	constructor(events: string[], store: FakeDevelopmentStore) {
		this.events = events;
		this.store = store;
	}

	async validateRuntime() {
		this.events.push("autopilot.validate-runtime");
		return { ok: true, message: "available", executablePath: "/usr/bin/autopilotagent" };
	}

	async validateTask() {
		this.events.push("autopilot.validate-task");
		return { ok: true, message: "valid", checksum: this.taskChecksum };
	}

	async start(request: Parameters<AutopilotRunner["start"]>[0]) {
		this.events.push("autopilot.start");
		this.startCalls += 1;
		return {
			projectId: request.projectId,
			featureId: request.featureId,
			projectRoot: request.projectRoot,
			taskRelativePath: request.taskRelativePath,
			expectedBranch: request.expectedBranch,
			processIdentity: { pid: 4242, startTimeMs: 987_654 },
			startedAt: NOW.toISOString(),
		};
	}

	async isAlive() {
		return false;
	}

	async signal() {}

	async wait(_handle: AutopilotRunHandle) {
		this.events.push("autopilot.wait");
		expect(this.store.seed.attempt.processPid).toBe(4242);
		expect(this.store.seed.attempt.processStartIdentity).toBe("987654");
		if (this.throwOnWait) throw this.throwOnWait;
		return this.result;
	}

	async readProgress() {
		return this.result.progress;
	}

	async observeCommits() {
		return [];
	}
}

class ImmediateHeartbeatScheduler implements HeartbeatScheduler {
	readonly events: string[];

	constructor(events: string[]) {
		this.events = events;
	}

	async run<T>(_intervalMs: number, heartbeat: () => Promise<void>, task: () => Promise<T>) {
		this.events.push("heartbeat.start");
		await heartbeat();
		this.events.push("heartbeat.renewed");
		const value = await task();
		this.events.push("heartbeat.stop");
		return value;
	}
}

function makeWorker(
	seed: SeededExecution,
	options: { claimedOverride?: DevelopmentAttemptRow } = {},
): {
	worker: DevelopmentWorker;
	store: FakeDevelopmentStore;
	git: FakeGitGateway;
	runner: FakeAutopilotRunner;
	events: string[];
} {
	const events: string[] = [];
	const store = new FakeDevelopmentStore(seed, events);
	const git = new FakeGitGateway(events);
	const runner = new FakeAutopilotRunner(events, store);
	const queue = new TargetedQueue(store.seed, options.claimedOverride);
	return {
		store,
		git,
		runner,
		events,
		worker: createDevelopmentWorker({
			store,
			queue,
			git,
			autopilot: runner,
			workerId: seed.workerId,
			workerRegistrationId: seed.workerRegistrationId,
			now: () => NOW,
			leaseDurationMs: 30_000,
			heartbeatIntervalMs: 5_000,
			heartbeatScheduler: new ImmediateHeartbeatScheduler(events),
		}),
	};
}

describe("development worker orchestration", () => {
	test("claims durable work, preflights before start, persists identity/heartbeat, and completes independently of HTTP", async () => {
		const seed = seedExecution();
		const { worker, store, git, events } = makeWorker(seed);

		const outcome = await worker.runOnce();

		expect(outcome).toEqual({ kind: "completed", attemptId: seed.attempt.id });
		expect(events.indexOf("git.preflight")).toBeLessThan(events.indexOf("autopilot.start"));
		expect(events.indexOf("autopilot.validate-runtime")).toBeLessThan(
			events.indexOf("autopilot.start"),
		);
		expect(events.indexOf("autopilot.validate-task")).toBeLessThan(
			events.indexOf("autopilot.start"),
		);
		expect(events.indexOf("git.ensure-branch")).toBeLessThan(events.indexOf("autopilot.start"));
		expect(events.indexOf("store.persist-process-identity")).toBeLessThan(
			events.indexOf("autopilot.wait"),
		);
		expect(store.heartbeats).toBe(1);
		expect(git.branchRequest?.createIfMissing).toBe(true);
		expect(git.preflightRequest).toMatchObject({
			projectRoot: seed.project.canonicalPath,
			remoteName: "origin",
			developmentBranch: "main",
			featureBranch: seed.feature.branchName,
			taskRelativePath: seed.approval.relativeTaskPath,
			taskChecksum: seed.approval.checksum,
		});
		expect(store.seed.attempt.status).toBe("SUCCEEDED");
		expect(store.seed.feature.state).toBe("DEVELOPMENT_COMPLETE");
		expect(store.outboxIntents).toBe(1);
		expect(store.activityTypes).toContain("development.completed");
	});

	test("reuses the persisted feature branch and current task progress for retry attempts", async () => {
		const seed = seedExecution({ retry: true });
		const { worker, git } = makeWorker(seed);

		await worker.runOnce();

		expect(git.branchRequest).toMatchObject({
			featureBranch: seed.feature.branchName,
			createIfMissing: false,
		});
	});

	for (const scenario of [
		{
			name: "zero exit with unpassed requirements",
			result: runResult({
				outcome: "incomplete",
				allPass: false,
				progress: progress({ passed: 1, remaining: 1, allPass: false }),
			}),
		},
		{
			name: "nonzero exit",
			result: runResult({ exitCode: 1, outcome: "failed", allPass: false }),
		},
		{
			name: "stuck requirement",
			result: runResult({
				outcome: "incomplete",
				allPass: false,
				progress: progress({ passed: 1, stuck: 1, remaining: 0, allPass: false }),
			}),
		},
		{
			name: "invalid test",
			result: runResult({
				outcome: "incomplete",
				allPass: false,
				progress: progress({ passed: 1, invalidTest: 1, remaining: 0, allPass: false }),
			}),
		},
		{
			name: "malformed empty terminal progress",
			result: runResult({
				progress: progress({ total: 0, passed: 0, remaining: 0, allPass: true }),
			}),
		},
	] as const) {
		test(`${scenario.name} fails safely and never creates a PR intent`, async () => {
			const seed = seedExecution();
			const { worker, runner, store } = makeWorker(seed);
			runner.result = scenario.result;

			const outcome = await worker.runOnce();

			expect(outcome.kind).toBe("failed");
			expect(store.seed.attempt.status).toBe("FAILED");
			expect(store.seed.feature.state).toBe("DEVELOPMENT_FAILED");
			expect(store.outboxIntents).toBe(0);
			expect(store.failures.length).toBe(1);
		});
	}

	test("timeout fails safely and never creates a PR intent", async () => {
		const seed = seedExecution();
		const { worker, runner, store } = makeWorker(seed);
		runner.throwOnWait = new Error("timed out");

		const outcome = await worker.runOnce();

		expect(outcome.kind).toBe("failed");
		expect(store.failures[0]?.failureKind).toBe("process");
		expect(store.outboxIntents).toBe(0);
	});

	test("blocks unsafe Git preflight without spawning Autopilot or creating a PR intent", async () => {
		const seed = seedExecution();
		const { worker, git, runner, store } = makeWorker(seed);
		git.preflightOk = false;

		const outcome = await worker.runOnce();

		expect(outcome.kind).toBe("blocked");
		expect(runner.startCalls).toBe(0);
		expect(store.seed.attempt.status).toBe("FAILED");
		expect(store.seed.feature.state).toBe("BLOCKED");
		expect(store.outboxIntents).toBe(0);
	});

	test("rejects a claim whose project identity differs from the persisted attempt", async () => {
		const seed = seedExecution();
		const claimedOverride = { ...seed.attempt, projectId: crypto.randomUUID() };
		const { worker, runner, store } = makeWorker(seed, { claimedOverride });

		const outcome = await worker.runOnce();

		expect(outcome.kind).toBe("blocked");
		expect(runner.startCalls).toBe(0);
		expect(store.seed.attempt.status).toBe("FAILED");
	});

	test("does not assume ownership of a claimed attempt that already has process identity", async () => {
		const seed = seedExecution({ processIdentity: true });
		const { worker, runner, store } = makeWorker(seed);

		const outcome = await worker.runOnce();

		expect(outcome.kind).toBe("blocked");
		expect(runner.startCalls).toBe(0);
		expect(store.failures.length).toBe(0);
	});
});
