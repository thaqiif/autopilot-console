/**
 * Narrow GitGateway port — no force-push, reset-hard, clean, rewrite, or branch-delete.
 */

export interface RepositoryIdentityView {
	owner: string;
	repository: string;
	fullName: string;
}

export interface GitPreflightRequest {
	/** Canonical absolute project path (already realpath'd). */
	projectRoot: string;
	/** Configured remote name (e.g. origin). */
	remoteName: string;
	/** Expected GitHub owner/repository. */
	expectedRepository: RepositoryIdentityView;
	/** Development/base branch on the remote. */
	developmentBranch: string;
	/** Deterministic feature branch feature/<id>-<slug>. */
	featureBranch: string;
	/** Project-relative approved task path (optional for pure repo checks). */
	taskRelativePath?: string;
	/** Expected task file checksum (sha256 hex); required when taskRelativePath set. */
	taskChecksum?: string;
	/** When true, task path may be dirty; other dirtiness still fails. */
	allowTaskArtifactDirty?: boolean;
}

export type GitPreflightFailureCode =
	| "NOT_A_GIT_REPOSITORY"
	| "REMOTE_MISSING"
	| "REMOTE_IDENTITY_MISMATCH"
	| "DEVELOPMENT_BRANCH_MISSING"
	| "FEATURE_BRANCH_MISMATCH"
	| "TASK_PATH_INVALID"
	| "TASK_CHECKSUM_MISMATCH"
	| "DIRTY_WORKTREE"
	| "PATH_INVALID";

export interface GitPreflightResult {
	ok: boolean;
	projectRoot: string;
	remoteName: string;
	remoteUrl: string;
	repository: RepositoryIdentityView;
	developmentBranch: string;
	featureBranch: string;
	headBranch: string | null;
	headSha: string | null;
	failures: Array<{ code: GitPreflightFailureCode; message: string }>;
}

export interface EnsureFeatureBranchRequest {
	projectRoot: string;
	remoteName: string;
	developmentBranch: string;
	featureBranch: string;
	/** When true, create from remote development tip; when false, require existing branch. */
	createIfMissing: boolean;
}

export interface EnsureFeatureBranchResult {
	featureBranch: string;
	created: boolean;
	headSha: string;
}

export interface CommitObservation {
	hash: string;
	subject: string;
	authoredAt?: string;
}

export interface ObserveCommitsRequest {
	projectRoot: string;
	featureBranch: string;
	/** Max commits to return (newest first). */
	limit?: number;
	/** Exclusive lower bound SHA (observe after this commit). */
	afterSha?: string;
}

export interface SafePushRequest {
	projectRoot: string;
	remoteName: string;
	featureBranch: string;
	/** Expected local HEAD SHA; push aborted on mismatch. */
	expectedHeadSha: string;
}

export interface SafePushResult {
	remoteName: string;
	featureBranch: string;
	headSha: string;
	/** True when remote already had the same SHA (no-op). */
	alreadyUpToDate: boolean;
}

/**
 * Constrained Git operations for Console. Implementations must not expose
 * force-push, reset --hard, clean, history rewrite, branch delete, or shell templates.
 */
export interface GitGateway {
	preflight(request: GitPreflightRequest): Promise<GitPreflightResult>;
	ensureFeatureBranch(request: EnsureFeatureBranchRequest): Promise<EnsureFeatureBranchResult>;
	observeCommits(request: ObserveCommitsRequest): Promise<CommitObservation[]>;
	pushFeatureBranch(request: SafePushRequest): Promise<SafePushResult>;
}
