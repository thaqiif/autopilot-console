/**
 * Fake external adapters for Phase 1 qualification tests (requirements 41–44).
 *
 * Provides deterministic in-memory implementations of GitGateway, GitHubGateway,
 * and AutopilotRunner so the full owner journey can run without real Git repos,
 * GitHub API calls, or the installed autopilot-multi CLI.
 *
 * All state is per-instance so tests are isolated.
 */

import type {
	AutopilotRunHandle,
	AutopilotRunner,
	RuntimeValidation,
	TaskValidation,
} from "../../packages/autopilot/src/index";
import type {
	CommitObservation,
	EnsureFeatureBranchRequest,
	EnsureFeatureBranchResult,
	GitGateway,
	GitPreflightRequest,
	GitPreflightResult,
	RepositoryIdentityView,
	SafePushRequest,
	SafePushResult,
} from "../../packages/git/src/index";
import type {
	CreatePullRequestRequest,
	FindPullRequestRequest,
	GitHubGateway,
	PullRequestIdentity,
	PullRequestStatus,
	ValidateAccessRequest,
	ValidateAccessResult,
} from "../../packages/github/src/index";

// ── Fake Git ────────────────────────────────────────────────────────────

export interface FakeGitState {
	preflightResults: Map<string, GitPreflightResult>;
	branches: Map<string, { headSha: string; created: boolean }>;
	pushes: SafePushRequest[];
	commits: Map<string, CommitObservation[]>;
}

export function createFakeGitState(): FakeGitState {
	return {
		preflightResults: new Map(),
		branches: new Map(),
		pushes: [],
		commits: new Map(),
	};
}

function okPreflight(request: GitPreflightRequest): GitPreflightResult {
	const repository: RepositoryIdentityView = {
		owner: request.expectedRepository.owner,
		repository: request.expectedRepository.repository,
		fullName: request.expectedRepository.fullName,
	};
	return {
		ok: true,
		projectRoot: request.projectRoot,
		remoteName: request.remoteName,
		remoteUrl: `https://github.com/${repository.fullName}.git`,
		repository,
		developmentBranch: request.developmentBranch,
		featureBranch: request.featureBranch,
		headBranch: request.developmentBranch,
		headSha: "abc123def456",
		failures: [],
	};
}

export function createFakeGit(overrides?: {
	state?: FakeGitState;
	preflight?: (req: GitPreflightRequest) => Promise<GitPreflightResult> | GitPreflightResult;
}): GitGateway {
	const state = overrides?.state ?? createFakeGitState();
	let commitCounter = 0;

	return {
		async preflight(request: GitPreflightRequest): Promise<GitPreflightResult> {
			if (overrides?.preflight) return overrides.preflight(request);
			const key = request.projectRoot;
			const existing = state.preflightResults.get(key);
			if (existing) return existing;
			return okPreflight(request);
		},

		async ensureFeatureBranch(
			request: EnsureFeatureBranchRequest,
		): Promise<EnsureFeatureBranchResult> {
			const key = `${request.projectRoot}:${request.featureBranch}`;
			const existing = state.branches.get(key);
			if (existing) {
				return {
					featureBranch: request.featureBranch,
					created: false,
					headSha: existing.headSha,
				};
			}
			const headSha = `branch-sha-${++commitCounter}`;
			state.branches.set(key, { headSha, created: true });
			return { featureBranch: request.featureBranch, created: true, headSha };
		},

		async observeCommits(): Promise<CommitObservation[]> {
			return [];
		},

		async pushFeatureBranch(request: SafePushRequest): Promise<SafePushResult> {
			state.pushes.push(request);
			return {
				remoteName: request.remoteName,
				featureBranch: request.featureBranch,
				headSha: request.expectedHeadSha,
				alreadyUpToDate: false,
			};
		},
	};
}

// ── Fake GitHub ─────────────────────────────────────────────────────────

export interface FakeGitHubState {
	prs: Map<string, PullRequestIdentity>;
	statuses: Map<number, PullRequestStatus>;
	accessResults: Map<string, ValidateAccessResult>;
	nextPrNumber: number;
}

export function createFakeGitHubState(): FakeGitHubState {
	return {
		prs: new Map(),
		statuses: new Map(),
		accessResults: new Map(),
		nextPrNumber: 1,
	};
}

export function createFakeGitHub(overrides?: {
	state?: FakeGitHubState;
	validateAccess?: (
		req: ValidateAccessRequest,
	) => Promise<ValidateAccessResult> | ValidateAccessResult;
}): GitHubGateway {
	const state = overrides?.state ?? createFakeGitHubState();

	return {
		async validateAuthentication() {
			return { ok: true, authenticated: true, login: "test-owner" };
		},

		async validateAccess(request: ValidateAccessRequest): Promise<ValidateAccessResult> {
			if (overrides?.validateAccess) return overrides.validateAccess(request);
			const key = request.repository.fullName;
			const existing = state.accessResults.get(key);
			if (existing) return existing;
			return {
				ok: true,
				authenticated: true,
				login: "test-owner",
				repositoryReadable: true,
				pushFeasible: true,
				failures: [],
			};
		},

		async findExistingPullRequest(
			request: FindPullRequestRequest,
		): Promise<PullRequestIdentity | null> {
			for (const pr of state.prs.values()) {
				if (
					pr.headBranch === request.headBranch &&
					pr.baseBranch === request.baseBranch &&
					pr.repository.fullName === `${request.repository.owner}/${request.repository.repository}`
				) {
					return pr;
				}
			}
			return null;
		},

		async createPullRequest(request: CreatePullRequestRequest): Promise<PullRequestIdentity> {
			const existing = await this.findExistingPullRequest({
				repository: request.repository,
				headBranch: request.headBranch,
				baseBranch: request.baseBranch,
			});
			if (existing) return existing;

			const number = state.nextPrNumber++;
			const identity: PullRequestIdentity = {
				repository: {
					owner: request.repository.owner,
					repository: request.repository.repository,
					fullName: `${request.repository.owner}/${request.repository.repository}`,
				},
				number,
				url: `https://github.com/${request.repository.owner}/${request.repository.repository}/pull/${number}`,
				originalHeadSha: "feature-sha-1",
				headBranch: request.headBranch,
				baseBranch: request.baseBranch,
			};
			state.prs.set(`${request.headBranch}:${request.baseBranch}`, identity);

			const status: PullRequestStatus = {
				...identity,
				state: "open",
				currentHeadSha: identity.originalHeadSha,
				checks: [],
				checkSummary: "none",
				reviewDecision: "REVIEW_REQUIRED",
				mergeCommitSha: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: new Date().toISOString(),
				mergeable: null,
			};
			state.statuses.set(number, status);
			return identity;
		},

		async getPullRequestStatus(request): Promise<PullRequestStatus> {
			const status = state.statuses.get(request.number);
			if (status) return status;
			return {
				repository: { owner: "acme", repository: "repo", fullName: "acme/repo" },
				number: request.number,
				url: `https://github.com/acme/repo/pull/${request.number}`,
				state: "open",
				currentHeadSha: "head-sha",
				headBranch: "feature/branch",
				baseBranch: "main",
				checks: [],
				checkSummary: "none",
				reviewDecision: "REVIEW_REQUIRED",
				mergeCommitSha: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: null,
				mergeable: null,
			};
		},
	};
}

/** Transition a PR to merged state in the fake GitHub state. */
export function mergePrExternally(
	state: FakeGitHubState,
	prNumber: number,
	mergeCommitSha: string,
): void {
	const status = state.statuses.get(prNumber);
	if (!status) return;
	state.statuses.set(prNumber, {
		...status,
		state: "merged",
		mergeCommitSha,
		mergedAt: new Date().toISOString(),
	});
}

// ── Fake AutopilotRunner ────────────────────────────────────────────────

export interface FakeAutopilotState {
	runs: Map<string, AutopilotRunHandle>;
	results: Map<string, { exitCode: number; allPass: boolean }>;
	progress: Map<string, { total: number; passed: number }>;
}

export function createFakeAutopilotState(): FakeAutopilotState {
	return {
		runs: new Map(),
		results: new Map(),
		progress: new Map(),
	};
}

export function createFakeAutopilot(overrides?: {
	state?: FakeAutopilotState;
	onStart?: (req: import("../../packages/autopilot/src/index").AutopilotStartRequest) => void;
}): AutopilotRunner {
	const state = overrides?.state ?? createFakeAutopilotState();
	let runCounter = 0;

	return {
		async validateRuntime(): Promise<RuntimeValidation> {
			return { ok: true, message: "autopilotagent available", executablePath: "/usr/bin/true" };
		},

		async validateTask(projectRoot: string, taskRelativePath: string): Promise<TaskValidation> {
			try {
				const { readFile } = await import("node:fs/promises");
				const { createHash } = await import("node:crypto");
				const { join } = await import("node:path");
				const bytes = await readFile(join(projectRoot, taskRelativePath));
				const checksum = createHash("sha256").update(bytes).digest("hex");
				return { ok: true, message: "task valid", checksum };
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : "task validation failed",
				};
			}
		},

		async start(
			request: import("../../packages/autopilot/src/index").AutopilotStartRequest,
		): Promise<AutopilotRunHandle> {
			overrides?.onStart?.(request);
			const handle: AutopilotRunHandle = {
				projectId: request.projectId,
				featureId: request.featureId,
				projectRoot: request.projectRoot,
				taskRelativePath: request.taskRelativePath,
				expectedBranch: request.expectedBranch,
				processIdentity: {
					pid: 10000 + ++runCounter,
					startTimeMs: Date.now(),
				},
				startedAt: new Date().toISOString(),
			};
			state.runs.set(request.projectId, handle);
			return handle;
		},

		async isAlive(): Promise<boolean> {
			return false;
		},

		async signal(): Promise<void> {},

		async wait(
			handle: AutopilotRunHandle,
		): Promise<import("../../packages/autopilot/src/index").NormalizedRunResult> {
			const result = state.results.get(handle.projectId);
			const exitCode = result?.exitCode ?? 0;
			const allPass = result?.allPass ?? true;
			return {
				exitCode,
				signal: null,
				outcome: allPass && exitCode === 0 ? "succeeded" : "failed",
				allPass,
				progress: {
					total: 2,
					passed: allPass ? 2 : 0,
					stuck: 0,
					invalidTest: 0,
					remaining: allPass ? 0 : 2,
					allPass,
					blockedReasons: [],
				},
				stdoutDiagnostic: "run complete",
				stderrDiagnostic: "",
				redactedMessage: allPass ? "All requirements pass" : "Some requirements failed",
			};
		},

		async readProgress(): Promise<import("../../packages/autopilot/src/index").ProgressSnapshot> {
			return {
				total: 2,
				passed: 2,
				stuck: 0,
				invalidTest: 0,
				remaining: 0,
				allPass: true,
				blockedReasons: [],
			};
		},

		async observeCommits(): Promise<Array<{ hash: string; subject: string; authoredAt?: string }>> {
			return [];
		},
	};
}

// ── Fake ProcessTreeInspector ───────────────────────────────────────────

export function createFakeProcessTree(): import("../../apps/worker/src/process/cancellation-controller").ProcessTreeInspector {
	return {
		async isAlive(_pid: number) {
			return false;
		},
		async getStartTime(_pid: number) {
			return null;
		},
		async getDescendantPids(_pid: number) {
			return [];
		},
		async sendSignal(_pid: number, _signal: string) {},
	};
}
