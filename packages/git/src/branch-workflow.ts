/**
 * Deterministic feature branch create/reuse from remote development tip.
 */

import { createNormalizedError, errorCodes } from "../../shared/src/errors/normalized-error";
import { redactSecrets } from "../../shared/src/security/redaction";
import { runGit, runGitOk } from "./cli-runner";
import type { EnsureFeatureBranchRequest, EnsureFeatureBranchResult } from "./git-gateway";

// feature/<feature-id>-<slug> — id may contain dots/underscores; slug is kebab.
const FEATURE_BRANCH_RE = /^feature\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9][A-Za-z0-9._-]*$/;

function precondition(message: string): never {
	throw createNormalizedError({
		code: errorCodes.PRECONDITION_FAILED,
		message: redactSecrets(message),
		httpStatus: 409,
	});
}

function validation(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

function localBranchExists(cwd: string, branch: string): boolean {
	const r = runGit(cwd, "show-ref", ["--verify", `refs/heads/${branch}`]);
	return r.status === 0;
}

/**
 * Ensure feature/<id>-<slug> exists and is checked out.
 * First attempt: create from origin/<developmentBranch>.
 * Retry: checkout existing branch (preserve progress).
 */
export async function ensureFeatureBranch(
	request: EnsureFeatureBranchRequest,
): Promise<EnsureFeatureBranchResult> {
	const { projectRoot, remoteName, developmentBranch, featureBranch, createIfMissing } = request;

	if (!FEATURE_BRANCH_RE.test(featureBranch)) {
		validation("Feature branch must match feature/<feature-id>-<slug>");
	}
	if (featureBranch.includes("..") || featureBranch.includes("//")) {
		validation("Feature branch is not a valid Git ref");
	}

	const isGit = runGit(projectRoot, "rev-parse", ["--is-inside-work-tree"]);
	if (isGit.status !== 0) {
		precondition("Path is not a Git worktree");
	}

	// Refresh remote tracking for development branch (no force).
	runGit(projectRoot, "fetch", [remoteName, developmentBranch]);

	const remoteRef = `refs/remotes/${remoteName}/${developmentBranch}`;
	const remoteTip = runGit(projectRoot, "rev-parse", ["--verify", remoteRef]);
	if (remoteTip.status !== 0) {
		precondition(`Development branch ${developmentBranch} not found on remote ${remoteName}`);
	}

	const exists = localBranchExists(projectRoot, featureBranch);

	if (!exists) {
		if (!createIfMissing) {
			precondition(`Feature branch ${featureBranch} does not exist`);
		}
		// Create from remote development tip and check out.
		runGitOk(projectRoot, "checkout", ["-b", featureBranch, remoteRef]);
		const headSha = runGitOk(projectRoot, "rev-parse", ["HEAD"]);
		return { featureBranch, created: true, headSha };
	}

	// Reuse: check out existing branch; do not reset.
	const current = runGit(projectRoot, "rev-parse", ["--abbrev-ref", "HEAD"]);
	if (current.status !== 0 || current.stdout.trim() !== featureBranch) {
		runGitOk(projectRoot, "checkout", [featureBranch]);
	}
	const headSha = runGitOk(projectRoot, "rev-parse", ["HEAD"]);
	return { featureBranch, created: false, headSha };
}
