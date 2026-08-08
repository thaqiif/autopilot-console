import { describe, expect, test } from "bun:test";
import type {
	GitHubGateway,
	PullRequestStatus,
	RepositoryRef,
	ValidateAccessResult,
} from "../../../../packages/github/src/index";
import {
	createPRReconciliationWorker,
	type PRReconciliationStore,
	type PRReconciliationWorker,
} from "./pr-reconciliation-worker";

const NOW = new Date("2026-07-18T16:00:00.000Z");
const REPO: RepositoryRef = { owner: "acme", repository: "project-a", fullName: "acme/project-a" };

interface PollablePR {
	featureId: string;
	projectId: string;
	prNumber: number;
	url: string;
	headBranch: string;
	baseBranch: string;
	originalHeadSha: string;
	observedHeadSha: string | null;
	observedState: string | null;
	featureState: string;
	lastObservedAt: Date | null;
}

function seedPR(overrides?: Partial<PollablePR>): PollablePR {
	return {
		featureId: crypto.randomUUID(),
		projectId: crypto.randomUUID(),
		prNumber: 42,
		url: "https://github.com/acme/project-a/pull/42",
		headBranch: "feature/abc-login",
		baseBranch: "main",
		originalHeadSha: "abc123",
		observedHeadSha: null,
		observedState: null,
		featureState: "CI_RUNNING",
		lastObservedAt: null,
		...overrides,
	};
}

function status(overrides: Partial<PullRequestStatus>): PullRequestStatus {
	return {
		repository: REPO,
		number: 42,
		url: "https://github.com/acme/project-a/pull/42",
		state: "open",
		currentHeadSha: "abc123",
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
		...overrides,
	};
}

class FakeReconciliationStore implements PRReconciliationStore {
	readonly events: string[];
	readonly prs: PollablePR[];
	activityTypes: string[] = [];
	featureTransitions: Array<{ from: string; to: string }> = [];
	featureStates: Map<string, string>;

	constructor(prs: PollablePR[], events: string[]) {
		this.events = events;
		this.prs = structuredClone(prs);
		this.featureStates = new Map(prs.map((p) => [p.featureId, p.featureState]));
	}

	async listOpenPRs() {
		this.events.push("store.list-open-prs");
		return this.prs
			.filter((p) => {
				const state = this.featureStates.get(p.featureId) ?? p.featureState;
				return !["DEVELOPMENT_MERGED", "BLOCKED"].includes(state);
			})
			.map((p) => ({
				...p,
				featureState: this.featureStates.get(p.featureId) ?? p.featureState,
			}));
	}

	async updatePRObservation(
		featureId: string,
		input: {
			observedHeadSha: string;
			observedState: string | null;
			lastObservedAt: Date;
		},
	) {
		this.events.push("store.update-pr-observation");
		const pr = this.prs.find((p) => p.featureId === featureId);
		if (pr) {
			// Stale observation protection: only update if newer
			if (pr.lastObservedAt && input.lastObservedAt <= pr.lastObservedAt) {
				return; // Skip stale
			}
			pr.observedHeadSha = input.observedHeadSha;
			pr.observedState = input.observedState;
			pr.lastObservedAt = input.lastObservedAt;
		}
	}

	async transitionFeature(
		featureId: string,
		input: { from: string; to: string; owner: string; operationId: string },
	) {
		this.events.push(`store.transition:${input.from}->${input.to}`);
		const current = this.featureStates.get(featureId);
		if (current !== input.from) {
			return { kind: "rejected" as const, reason: "state_conflict" as const };
		}
		this.featureStates.set(featureId, input.to);
		this.featureTransitions.push({ from: input.from, to: input.to });
		return { kind: "applied" as const };
	}

	async recordActivity(input: {
		projectId: string;
		featureId?: string;
		type: string;
		summary: string;
		metadata?: unknown;
	}) {
		this.events.push(`store.activity:${input.type}`);
		this.activityTypes.push(input.type);
	}

	async recordAudit(input: { projectId: string; actor: string; action: string; target: string }) {
		this.events.push(`store.audit:${input.action}`);
	}

	async recordBackoff(featureId: string, _error: string) {
		this.events.push(`store.record-backoff:${featureId}`);
	}

	async shouldBackoff(_featureId: string): Promise<boolean> {
		return false;
	}
}

class FakeGitHubForReconciliation implements GitHubGateway {
	readonly events: string[];
	statuses = new Map<string, PullRequestStatus>();
	errors = new Map<string, Error>();
	validateResult: ValidateAccessResult = {
		ok: true,
		authenticated: true,
		login: "acme-bot",
		repositoryReadable: true,
		pushFeasible: true,
		failures: [],
	};

	constructor(events: string[]) {
		this.events = events;
	}

	setStatus(prNumber: number, st: PullRequestStatus) {
		this.statuses.set(String(prNumber), st);
	}

	setError(prNumber: number, error: Error) {
		this.errors.set(String(prNumber), error);
	}

	async validateAuthentication() {
		return {
			ok: this.validateResult.ok,
			authenticated: this.validateResult.authenticated,
			login: this.validateResult.login,
		};
	}

	async validateAccess() {
		return this.validateResult;
	}

	async findExistingPullRequest() {
		return null;
	}

	async createPullRequest(): Promise<never> {
		throw new Error("reconciliation does not create PRs");
	}

	async getPullRequestStatus(request: {
		repository: RepositoryRef;
		number: number;
	}): Promise<PullRequestStatus> {
		this.events.push(`github.get-status:${request.number}`);
		const error = this.errors.get(String(request.number));
		if (error) throw error;
		return this.statuses.get(String(request.number)) ?? status({ number: request.number });
	}
}

function makeReconciliationWorker(options?: {
	prs?: PollablePR[];
	github?: FakeGitHubForReconciliation;
}): {
	worker: PRReconciliationWorker;
	store: FakeReconciliationStore;
	github: FakeGitHubForReconciliation;
	events: string[];
} {
	const events: string[] = [];
	const prs = options?.prs ?? [seedPR()];
	const store = new FakeReconciliationStore(prs, events);
	const github = options?.github ?? new FakeGitHubForReconciliation(events);
	const worker = createPRReconciliationWorker({
		store,
		github,
		repository: REPO,
		now: () => NOW,
	});
	return { worker, store, github, events };
}

describe("PR reconciliation worker", () => {
	test("pending checks keep feature in CI_RUNNING", async () => {
		const pr = seedPR();
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "abc123",
				checks: [{ name: "ci", conclusion: "pending", bucket: "pending", headSha: "abc123" }],
				checkSummary: "pending",
				reviewDecision: "NONE",
			}),
		);

		const count = await worker.pollAll();

		expect(count).toBe(1);
		expect(store.featureStates.get(pr.featureId)).toBe("CI_RUNNING");
	});

	test("all checks passing transitions to PR_REVIEW", async () => {
		const pr = seedPR();
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "abc123",
				checks: [{ name: "ci", conclusion: "success", bucket: "pass", headSha: "abc123" }],
				checkSummary: "passing",
				reviewDecision: "NONE",
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("PR_REVIEW");
		expect(store.activityTypes).toContain("ci.passed");
	});

	test("failed checks transition to CI_FAILED", async () => {
		const pr = seedPR();
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "abc123",
				checks: [{ name: "ci", conclusion: "failure", bucket: "fail", headSha: "abc123" }],
				checkSummary: "failing",
				reviewDecision: "NONE",
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("CI_FAILED");
		expect(store.activityTypes).toContain("ci.failed");
	});

	test("requested changes transitions to PR_CHANGES_REQUESTED", async () => {
		const pr = seedPR({ featureState: "PR_REVIEW" });
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "abc123",
				checks: [],
				checkSummary: "passing",
				reviewDecision: "CHANGES_REQUESTED",
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("PR_CHANGES_REQUESTED");
		expect(store.activityTypes).toContain("pr.changes_requested");
	});

	test("merged PR transitions to DEVELOPMENT_MERGED (terminal)", async () => {
		const pr = seedPR({ featureState: "PR_REVIEW" });
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "merged",
				currentHeadSha: "abc123",
				checks: [],
				checkSummary: "passing",
				reviewDecision: "APPROVED",
				mergedAt: NOW.toISOString(),
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("DEVELOPMENT_MERGED");
		expect(store.activityTypes).toContain("pr.merged");
	});

	test("closed without merge transitions to BLOCKED", async () => {
		const pr = seedPR({ featureState: "PR_REVIEW" });
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "closed",
				currentHeadSha: "abc123",
				checks: [],
				checkSummary: "none",
				reviewDecision: "NONE",
				closedAt: NOW.toISOString(),
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("BLOCKED");
		expect(store.activityTypes).toContain("pr.closed_without_merge");
	});

	test("newer head observation is never overwritten by older poll", async () => {
		const newerTime = new Date("2026-07-18T16:05:00.000Z");
		const pr = seedPR({
			featureState: "CI_RUNNING",
			observedHeadSha: "new-sha",
			lastObservedAt: newerTime,
		});
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "old-sha",
				checks: [],
				checkSummary: "none",
				reviewDecision: "NONE",
			}),
		);

		// The observation from NOW (16:00) is older than newerTime (16:05)
		await worker.pollAll();

		// Should NOT have overwritten the newer observation
		const updatedPR = store.prs.find((p) => p.featureId === pr.featureId);
		expect(updatedPR?.observedHeadSha).toBe("new-sha");
	});

	test("transient GitHub error records backoff without state regression", async () => {
		const pr = seedPR({ featureState: "CI_RUNNING" });
		const github = new FakeGitHubForReconciliation([]);
		github.setError(pr.prNumber, new Error("GitHub API 503"));
		const { worker, store } = makeReconciliationWorker({ prs: [pr], github });

		await worker.pollAll();

		// Feature state should NOT regress
		expect(store.featureStates.get(pr.featureId)).toBe("CI_RUNNING");
		expect(store.events).toContain(`store.record-backoff:${pr.featureId}`);
	});

	test("repeated failures create stale-sync attention", async () => {
		const pr = seedPR({ featureState: "CI_RUNNING" });
		const github = new FakeGitHubForReconciliation([]);
		github.setError(pr.prNumber, new Error("timeout"));
		const events: string[] = [];
		const store = new FakeReconciliationStore([pr], events);
		// Simulate that we should trigger stale-sync after backoff threshold
		let backoffCount = 0;
		store.shouldBackoff = async () => {
			backoffCount++;
			return backoffCount > 3;
		};
		const worker = createPRReconciliationWorker({
			store,
			github,
			repository: REPO,
			now: () => NOW,
			maxConsecutiveErrors: 3,
		});

		// Poll multiple times to trigger repeated failures
		await worker.pollAll();
		await worker.pollAll();
		await worker.pollAll();
		await worker.pollAll();

		expect(store.activityTypes).toContain("pr.stale_sync");
		expect(store.featureStates.get(pr.featureId)).toBe("CI_RUNNING"); // no regression
	});

	test("no-checks case with open PR transitions to PR_REVIEW", async () => {
		const pr = seedPR({ featureState: "CI_RUNNING" });
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "abc123",
				checks: [],
				checkSummary: "none",
				reviewDecision: "NONE",
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("PR_REVIEW");
	});

	test("new head push re-enters CI_RUNNING from CI_FAILED", async () => {
		const pr = seedPR({ featureState: "CI_FAILED" });
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		// Simulate a new push with new checks
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "new-commit-sha",
				checks: [
					{ name: "ci", conclusion: "pending", bucket: "pending", headSha: "new-commit-sha" },
				],
				checkSummary: "pending",
				reviewDecision: "NONE",
			}),
		);

		await worker.pollAll();

		// New head with pending checks should re-enter CI_RUNNING
		expect(store.featureStates.get(pr.featureId)).toBe("CI_RUNNING");
	});

	test("changes_requested with new passing checks transitions back to PR_REVIEW", async () => {
		const pr = seedPR({ featureState: "PR_CHANGES_REQUESTED" });
		const { worker, github, store } = makeReconciliationWorker({ prs: [pr] });
		github.setStatus(
			pr.prNumber,
			status({
				state: "open",
				currentHeadSha: "new-push",
				checks: [{ name: "ci", conclusion: "success", bucket: "pass", headSha: "new-push" }],
				checkSummary: "passing",
				reviewDecision: "NONE",
			}),
		);

		await worker.pollAll();

		expect(store.featureStates.get(pr.featureId)).toBe("PR_REVIEW");
	});

	test("no open PRs results in idle poll", async () => {
		const events: string[] = [];
		const store = new FakeReconciliationStore([], events);
		const github = new FakeGitHubForReconciliation(events);
		const worker = createPRReconciliationWorker({
			store,
			github,
			repository: REPO,
			now: () => NOW,
		});

		const count = await worker.pollAll();

		expect(count).toBe(0);
	});
});
