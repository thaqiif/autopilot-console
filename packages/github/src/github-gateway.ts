/**
 * Narrow GitHubGateway port — no approve or merge operations.
 */

export interface RepositoryRef {
	owner: string;
	repository: string;
	fullName: string;
}

/** Immutable PR identity (persisted once; never rewritten for status). */
export interface PullRequestIdentity {
	repository: RepositoryRef;
	number: number;
	url: string;
	/** Original head SHA at creation/lookup time. */
	originalHeadSha: string;
	headBranch: string;
	baseBranch: string;
}

export type PullRequestLifecycleState = "open" | "closed" | "merged";

export type CheckConclusion =
	| "pending"
	| "success"
	| "failure"
	| "neutral"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "action_required"
	| "unknown";

export interface CheckObservation {
	name: string;
	conclusion: CheckConclusion;
	/** Bucket from gh when available. */
	bucket?: "pass" | "fail" | "pending" | "skipping" | "cancel";
	/** Check is for this head SHA (must match currentHeadSha). */
	headSha: string;
	detailsUrl?: string;
}

export type ReviewDecision =
	| "APPROVED"
	| "CHANGES_REQUESTED"
	| "REVIEW_REQUIRED"
	| "NONE"
	| "UNKNOWN";

/** Mutable PR observation for a single poll. */
export interface PullRequestStatus {
	repository: RepositoryRef;
	number: number;
	url: string;
	state: PullRequestLifecycleState;
	/** Current head SHA (may differ from original). */
	currentHeadSha: string;
	headBranch: string;
	baseBranch: string;
	/** Checks evaluated only for currentHeadSha. */
	checks: CheckObservation[];
	/** Aggregate check status for current head only. */
	checkSummary: "pending" | "passing" | "failing" | "none";
	reviewDecision: ReviewDecision;
	mergeCommitSha: string | null;
	mergedAt: string | null;
	closedAt: string | null;
	updatedAt: string | null;
	mergeable: boolean | null;
}

export interface ValidateAccessRequest {
	repository: RepositoryRef;
	/** Optional local project root for gh --repo context (unused when runner injects). */
	projectRoot?: string;
}

/** Session-level authentication probe (no repository required). */
export interface ValidateAuthenticationResult {
	ok: boolean;
	authenticated: boolean;
	login: string | null;
}

export interface ValidateAccessResult {
	ok: boolean;
	authenticated: boolean;
	login: string | null;
	repositoryReadable: boolean;
	/** Non-mutating push-permission probe where feasible. */
	pushFeasible: boolean | null;
	failures: Array<{ code: string; message: string }>;
}

export interface FindPullRequestRequest {
	repository: RepositoryRef;
	headBranch: string;
	baseBranch: string;
	/** Search open, closed, merged, or all (default all for idempotent create). */
	state?: "open" | "closed" | "merged" | "all";
}

export interface CreatePullRequestRequest {
	repository: RepositoryRef;
	headBranch: string;
	baseBranch: string;
	title: string;
	body: string;
}

export interface GetPullRequestStatusRequest {
	repository: RepositoryRef;
	/** PR number. */
	number: number;
}

/**
 * Typed GitHub operations for Console. Implementations must not expose
 * approve, merge, or arbitrary gh command templates.
 */
export interface GitHubGateway {
	/** Session-level auth check for readiness when no project is registered. */
	validateAuthentication(): Promise<ValidateAuthenticationResult>;
	validateAccess(request: ValidateAccessRequest): Promise<ValidateAccessResult>;
	findExistingPullRequest(request: FindPullRequestRequest): Promise<PullRequestIdentity | null>;
	createPullRequest(request: CreatePullRequestRequest): Promise<PullRequestIdentity>;
	getPullRequestStatus(request: GetPullRequestStatusRequest): Promise<PullRequestStatus>;
}
