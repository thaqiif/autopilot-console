import { describe, expect, test } from "bun:test";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	ProjectRow,
	TaskApprovalRow,
} from "../../../../packages/database/src/index";
import type { GitGateway, SafePushResult } from "../../../../packages/git/src/index";
import type {
	GitHubGateway,
	PullRequestIdentity,
	PullRequestStatus,
	RepositoryRef,
	ValidateAccessResult,
} from "../../../../packages/github/src/index";
import {
	createPRHandoffWorker,
	type PRHandoffStore,
	type PRHandoffWorker,
} from "./pr-handoff-worker";

const NOW = new Date("2026-07-18T16:00:00.000Z");
const REPO: RepositoryRef = { owner: "acme", repository: "project-a", fullName: "acme/project-a" };

interface SeededHandoff {
	project: ProjectRow;
	feature: FeatureRow;
	attempt: DevelopmentAttemptRow;
	approval: TaskApprovalRow;
	workerId: string;
}

function seedHandoff(overrides?: {
	featureState?: string;
	attemptStatus?: DevelopmentAttemptRow["status"];
}): SeededHandoff {
	const projectId = crypto.randomUUID();
	const featureId = crypto.randomUUID();
	const attemptId = crypto.randomUUID();
	const approvalId = crypto.randomUUID();
	return {
		project: {
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
		},
		feature: {
			id: featureId,
			projectId,
			releaseId: crypto.randomUUID(),
			slug: "login",
			title: "Login",
			summary: null,
			state: (overrides?.featureState ?? "DEVELOPMENT_COMPLETE") as FeatureRow["state"],
			branchName: `feature/${featureId}-login`,
			taskPath: "docs/tasks/login.json",
			rowVersion: 6,
			archivedAt: null,
			createdAt: NOW,
			updatedAt: NOW,
		},
		attempt: {
			id: attemptId,
			projectId,
			featureId,
			taskApprovalId: approvalId,
			branchName: `feature/${featureId}-login`,
			operationKey: `develop:${attemptId}`,
			status: overrides?.attemptStatus ?? "SUCCEEDED",
			predecessorAttemptId: null,
			workerRegistrationId: crypto.randomUUID(),
			processPid: 4242,
			processStartIdentity: "987654",
			leaseExpiresAt: null,
			heartbeatAt: NOW,
			enqueuedAt: NOW,
			startedAt: NOW,
			endedAt: NOW,
			exitCode: 0,
			cancellationRequestedAt: null,
			cancellationReason: null,
			structuredResult: { allPass: true },
			createdAt: NOW,
			updatedAt: NOW,
		},
		approval: {
			id: approvalId,
			projectId,
			featureId,
			relativeTaskPath: "docs/tasks/login.json",
			checksum: "sha256:approved",
			schemaCompatibilityVersion: "1",
			requirementsSnapshot: { requirements: [{ id: "1", passes: true }] },
			approvedByAdminId: crypto.randomUUID(),
			approvedAt: NOW,
			invalidatedAt: null,
			createdAt: NOW,
		},
		workerId: "worker-handoff-1",
	};
}

class FakePRHandoffStore implements PRHandoffStore {
	readonly seed: SeededHandoff;
	readonly events: string[];
	featureState: string;
	activityTypes: string[] = [];
	prIdentity: {
		id: string;
		number: number;
		url: string;
		headBranch: string;
		baseBranch: string;
		originalHeadSha: string;
	} | null = null;
	outboxIntents: Array<{
		kind: string;
		dedupeKey: string;
		payload?: unknown;
		projectId?: string;
		featureId?: string;
	}> = [];
	failureState: { featureState: string; reason: string } | null = null;
	idempotencyResults: Map<string, unknown> = new Map();

	constructor(seed: SeededHandoff, events: string[]) {
		this.seed = structuredClone(seed);
		this.events = events;
		this.featureState = seed.feature.state;
	}

	async loadHandoffContext(attemptId: string) {
		this.events.push("store.load-context");
		if (attemptId !== this.seed.attempt.id) return null;
		return {
			attempt: structuredClone(this.seed.attempt),
			project: structuredClone(this.seed.project),
			feature: { ...structuredClone(this.seed.feature), state: this.featureState },
			approval: structuredClone(this.seed.approval),
		};
	}

	async getExistingPRByFeature(featureId: string) {
		this.events.push("store.get-existing-pr");
		if (this.prIdentity && featureId === this.seed.feature.id) {
			return this.prIdentity;
		}
		return null;
	}

	async persistPRIdentity(
		_featureId: string,
		input: {
			projectId: string;
			repositoryOwner: string;
			repositoryName: string;
			number: number;
			url: string;
			headBranch: string;
			baseBranch: string;
			originalHeadSha: string;
		},
	) {
		this.events.push("store.persist-pr-identity");
		this.prIdentity = {
			id: crypto.randomUUID(),
			number: input.number,
			url: input.url,
			headBranch: input.headBranch,
			baseBranch: input.baseBranch,
			originalHeadSha: input.originalHeadSha,
		};
		return {
			id: this.prIdentity.id,
			number: input.number,
			url: input.url,
			headBranch: input.headBranch,
			baseBranch: input.baseBranch,
			originalHeadSha: input.originalHeadSha,
		};
	}

	async transitionFeature(
		_featureId: string,
		input: { from: string; to: string; owner: string; operationId: string },
	) {
		this.events.push(`store.transition:${input.from}->${input.to}`);
		if (this.featureState !== input.from) {
			return { kind: "rejected" as const, reason: "state_conflict" as const };
		}
		this.featureState = input.to;
		this.seed.feature.rowVersion += 1;
		return { kind: "applied" as const };
	}

	async recordActivity(input: {
		projectId: string;
		featureId?: string;
		attemptId?: string;
		type: string;
		summary: string;
		metadata?: unknown;
	}) {
		this.events.push(`store.activity:${input.type}`);
		this.activityTypes.push(input.type);
	}

	async recordAudit(input: {
		projectId: string;
		actor: string;
		action: string;
		target: string;
		prior?: unknown;
		next?: unknown;
	}) {
		this.events.push(`store.audit:${input.action}`);
	}

	async createOutboxIntent(input: {
		projectId: string;
		featureId?: string;
		kind: string;
		dedupeKey: string;
		payload?: unknown;
	}) {
		this.events.push(`store.outbox:${input.kind}`);
		this.outboxIntents.push(input);
	}

	async persistFailure(input: {
		featureId: string;
		targetState: string;
		reason: string;
		activityType: string;
	}) {
		this.events.push(`store.persist-failure:${input.targetState}`);
		this.failureState = { featureState: input.targetState, reason: input.reason };
		this.featureState = input.targetState;
	}

	async checkIdempotency(operationKey: string) {
		return this.idempotencyResults.get(operationKey) ?? null;
	}

	async recordIdempotency(operationKey: string, result: unknown) {
		this.idempotencyResults.set(operationKey, result);
	}
}

class FakeGitForHandoff implements GitGateway {
	readonly events: string[];
	pushResult: SafePushResult = {
		remoteName: "origin",
		featureBranch: "feature/abc-login",
		headSha: "def456",
		alreadyUpToDate: false,
	};
	pushError: Error | null = null;
	resolveError: Error | null = null;

	constructor(events: string[]) {
		this.events = events;
	}

	async preflight() {
		this.events.push("git.preflight");
		return {
			ok: true,
			projectRoot: "/workspaces/project-a",
			remoteName: "origin",
			remoteUrl: "https://github.com/acme/project-a.git",
			repository: REPO,
			developmentBranch: "main",
			featureBranch: "feature/abc-login",
			headBranch: "feature/abc-login",
			headSha: "def456",
			failures: [],
		};
	}

	async ensureFeatureBranch() {
		this.events.push("git.ensure-branch");
		if (this.resolveError) throw this.resolveError;
		return { featureBranch: "feature/abc-login", created: false, headSha: "def456" };
	}

	async observeCommits() {
		return [];
	}

	async pushFeatureBranch() {
		this.events.push("git.push");
		if (this.pushError) throw this.pushError;
		return this.pushResult;
	}
}

class FakeGitHubForHandoff implements GitHubGateway {
	readonly events: string[];
	existingPR: PullRequestIdentity | null = null;
	createdPR: PullRequestIdentity;
	validateResult: ValidateAccessResult = {
		ok: true,
		authenticated: true,
		login: "acme-bot",
		repositoryReadable: true,
		pushFeasible: true,
		failures: [],
	};
	validateError: Error | null = null;
	createError: Error | null = null;
	statusResult: PullRequestStatus | null = null;

	constructor(events: string[]) {
		this.events = events;
		this.createdPR = {
			repository: REPO,
			number: 42,
			url: "https://github.com/acme/project-a/pull/42",
			headBranch: "feature/abc-login",
			baseBranch: "main",
			originalHeadSha: "def456",
		};
	}

	async validateAuthentication() {
		return {
			ok: this.validateResult.ok,
			authenticated: this.validateResult.authenticated,
			login: this.validateResult.login,
		};
	}

	async validateAccess() {
		this.events.push("github.validate-access");
		if (this.validateError) throw this.validateError;
		return this.validateResult;
	}

	async findExistingPullRequest() {
		this.events.push("github.find-pr");
		return this.existingPR;
	}

	async createPullRequest() {
		this.events.push("github.create-pr");
		if (this.createError) throw this.createError;
		return this.createdPR;
	}

	async getPullRequestStatus(_request: { repository: RepositoryRef; number: number }) {
		this.events.push("github.get-status");
		return (
			this.statusResult ?? {
				repository: REPO,
				number: 42,
				url: "https://github.com/acme/project-a/pull/42",
				state: "open",
				currentHeadSha: "def456",
				headBranch: "feature/abc-login",
				baseBranch: "main",
				checks: [],
				checkSummary: "none",
				reviewDecision: "NONE",
				mergeCommitSha: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: null,
				mergeable: null,
			}
		);
	}
}

function makeHandoffWorker(
	seed: SeededHandoff,
	options?: { store?: FakePRHandoffStore },
): {
	worker: PRHandoffWorker;
	store: FakePRHandoffStore;
	git: FakeGitForHandoff;
	github: FakeGitHubForHandoff;
	events: string[];
} {
	const events: string[] = [];
	const store = options?.store ?? new FakePRHandoffStore(seed, events);
	const git = new FakeGitForHandoff(events);
	const github = new FakeGitHubForHandoff(events);
	const worker = createPRHandoffWorker({
		store,
		git,
		github,
		workerId: seed.workerId,
		remoteName: "origin",
		now: () => NOW,
	});
	return { worker, store, git, github, events };
}

describe("PR handoff worker", () => {
	test("pushes branch and creates PR, persists identity, transitions to CI_RUNNING", async () => {
		const seed = seedHandoff();
		const { worker, store, events } = makeHandoffWorker(seed);

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("completed");
		expect(events).toContain("git.ensure-branch");
		expect(events).toContain("git.push");
		expect(events).toContain("github.create-pr");
		expect(events).toContain("store.persist-pr-identity");
		expect(store.prIdentity).not.toBeNull();
		expect(store.prIdentity?.number).toBe(42);
		expect(store.featureState).toBe("CI_RUNNING");
		expect(store.activityTypes).toContain("pr.created");
	});

	test("reuses existing GitHub PR without creating a duplicate", async () => {
		const seed = seedHandoff();
		const { worker, github, store, events } = makeHandoffWorker(seed);
		github.existingPR = {
			repository: REPO,
			number: 17,
			url: "https://github.com/acme/project-a/pull/17",
			headBranch: "feature/abc-login",
			baseBranch: "main",
			originalHeadSha: "def456",
		};

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("completed");
		expect(events).toContain("github.find-pr");
		expect(events).not.toContain("github.create-pr");
		expect(store.prIdentity?.number).toBe(17);
	});

	test("skips push when already up to date and still creates/looks up PR", async () => {
		const seed = seedHandoff();
		const { worker, git, events } = makeHandoffWorker(seed);
		git.pushResult = {
			remoteName: "origin",
			featureBranch: "feature/abc-login",
			headSha: "def456",
			alreadyUpToDate: true,
		};

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("completed");
		expect(events).toContain("git.push");
		expect(events).toContain("github.create-pr");
	});

	test("branch resolution failure transitions to PR_CREATION_FAILED", async () => {
		const seed = seedHandoff();
		const { worker, git, store } = makeHandoffWorker(seed);
		git.resolveError = new Error("branch missing");

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("failed");
		expect(store.failureState?.featureState).toBe("PR_CREATION_FAILED");
		expect(store.failureState?.reason).toContain("Branch");
	});

	test("push failure transitions to PR_CREATION_FAILED with attention", async () => {
		const seed = seedHandoff();
		const { worker, git, store } = makeHandoffWorker(seed);
		git.pushError = new Error("remote rejected");

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("failed");
		expect(store.failureState?.featureState).toBe("PR_CREATION_FAILED");
		expect(store.failureState?.reason).toContain("Push");
	});

	test("PR creation failure transitions to PR_CREATION_FAILED", async () => {
		const seed = seedHandoff();
		const { worker, github, store } = makeHandoffWorker(seed);
		github.createError = new Error("gh: could not create PR");

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("failed");
		expect(store.failureState?.featureState).toBe("PR_CREATION_FAILED");
	});

	test("returns idle when attempt not found", async () => {
		const seed = seedHandoff();
		const { worker } = makeHandoffWorker(seed);

		const outcome = await worker.handoff("nonexistent-id");

		expect(outcome.kind).toBe("idle");
	});

	test("returns idle when feature is not in DEVELOPMENT_COMPLETE", async () => {
		const seed = seedHandoff({ featureState: "DEVELOPING" });
		const { worker } = makeHandoffWorker(seed);

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("idle");
	});

	test("crash after push but before PR creation can recover with existing PR lookup", async () => {
		const seed = seedHandoff();
		const store = new FakePRHandoffStore(seed, []);
		const events: string[] = [];
		const git = new FakeGitForHandoff(events);
		const github = new FakeGitHubForHandoff(events);

		// Simulate: feature is PR_CREATING (crash happened after transition)
		store.featureState = "PR_CREATING";
		const worker = createPRHandoffWorker({
			store,
			git,
			github,
			workerId: seed.workerId,
			remoteName: "origin",
			now: () => NOW,
		});

		// GitHub already has the PR from the first attempt
		github.existingPR = {
			repository: REPO,
			number: 99,
			url: "https://github.com/acme/project-a/pull/99",
			headBranch: "feature/abc-login",
			baseBranch: "main",
			originalHeadSha: "def456",
		};

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("completed");
		expect(events).not.toContain("github.create-pr");
		expect(store.prIdentity?.number).toBe(99);
	});

	test("duplicate operation key returns idempotent result", async () => {
		const seed = seedHandoff();
		const store = new FakePRHandoffStore(seed, []);
		store.featureState = "CI_RUNNING";
		store.prIdentity = {
			id: crypto.randomUUID(),
			number: 42,
			url: "https://github.com/acme/project-a/pull/42",
			headBranch: "feature/abc-login",
			baseBranch: "main",
			originalHeadSha: "def456",
		};
		store.idempotencyResults.set(`pr-handoff:${seed.attempt.id}`, {
			kind: "completed",
			prNumber: 42,
		});
		const events: string[] = [];
		const worker = createPRHandoffWorker({
			store,
			git: new FakeGitForHandoff(events),
			github: new FakeGitHubForHandoff(events),
			workerId: seed.workerId,
			remoteName: "origin",
			now: () => NOW,
		});

		const outcome = await worker.handoff(seed.attempt.id);

		expect(outcome.kind).toBe("completed");
		expect(events).not.toContain("git.push");
		expect(events).not.toContain("github.create-pr");
	});
});
