/**
 * Deterministic feature branch create/reuse from remote development tip.
 */

import { localBranchExists, runGit, runGitOk } from "./cli-runner";
import { assertFeatureBranchName, preconditionError } from "./errors";
import type { EnsureFeatureBranchRequest, EnsureFeatureBranchResult } from "./git-gateway";

/**
 * Ensure feature/<id>-<slug> exists and is checked out.
 * First attempt: create from origin/<developmentBranch>.
 * Retry: checkout existing branch (preserve progress).
 */
export async function ensureFeatureBranch(
	request: EnsureFeatureBranchRequest,
): Promise<EnsureFeatureBranchResult> {
	const { projectRoot, remoteName, developmentBranch, featureBranch, createIfMissing } = request;

	assertFeatureBranchName(featureBranch);

	const isGit = runGit(projectRoot, "rev-parse", ["--is-inside-work-tree"]);
	if (isGit.status !== 0) {
		preconditionError("Path is not a Git worktree");
	}

	// Refresh remote tracking for development branch (no force).
	runGit(projectRoot, "fetch", [remoteName, developmentBranch]);

	const remoteRef = `refs/remotes/${remoteName}/${developmentBranch}`;
	if (runGit(projectRoot, "rev-parse", ["--verify", remoteRef]).status !== 0) {
		preconditionError(`Development branch ${developmentBranch} not found on remote ${remoteName}`);
	}

	const exists = localBranchExists(projectRoot, featureBranch);

	if (!exists) {
		if (!createIfMissing) {
			preconditionError(`Feature branch ${featureBranch} does not exist`);
		}
		runGitOk(projectRoot, "checkout", ["-b", featureBranch, remoteRef]);
		return {
			featureBranch,
			created: true,
			headSha: runGitOk(projectRoot, "rev-parse", ["HEAD"]),
		};
	}

	const current = runGit(projectRoot, "rev-parse", ["--abbrev-ref", "HEAD"]);
	if (current.status !== 0 || current.stdout.trim() !== featureBranch) {
		runGitOk(projectRoot, "checkout", [featureBranch]);
	}
	return {
		featureBranch,
		created: false,
		headSha: runGitOk(projectRoot, "rev-parse", ["HEAD"]),
	};
}
