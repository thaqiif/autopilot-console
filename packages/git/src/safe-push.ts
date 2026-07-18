/**
 * Idempotent safe push of the verified feature branch HEAD (no force).
 */

import { createNormalizedError, errorCodes } from "../../shared/src/errors/normalized-error";
import { redactSecrets } from "../../shared/src/security/redaction";
import { runGit, runGitOk } from "./cli-runner";
import type { SafePushRequest, SafePushResult } from "./git-gateway";

function precondition(message: string): never {
	throw createNormalizedError({
		code: errorCodes.PRECONDITION_FAILED,
		message: redactSecrets(message),
		httpStatus: 409,
	});
}

export async function pushFeatureBranch(request: SafePushRequest): Promise<SafePushResult> {
	const { projectRoot, remoteName, featureBranch, expectedHeadSha } = request;

	if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
		precondition("expectedHeadSha must be a 40-char commit SHA");
	}

	const exists = runGit(projectRoot, "show-ref", ["--verify", `refs/heads/${featureBranch}`]);
	if (exists.status !== 0) {
		precondition(`Feature branch ${featureBranch} does not exist`);
	}

	// Ensure we are on the feature branch (or at least the ref tip matches).
	const head = runGitOk(projectRoot, "rev-parse", ["HEAD"]).toLowerCase();
	const branchTip = runGitOk(projectRoot, "rev-parse", [featureBranch]).toLowerCase();
	const expected = expectedHeadSha.toLowerCase();

	if (branchTip !== expected) {
		precondition("Feature branch tip does not match expectedHeadSha");
	}
	if (head !== expected) {
		// Check out the feature branch so push publishes the expected tip.
		runGitOk(projectRoot, "checkout", [featureBranch]);
		const head2 = runGitOk(projectRoot, "rev-parse", ["HEAD"]).toLowerCase();
		if (head2 !== expected) {
			precondition("HEAD does not match expectedHeadSha after checkout");
		}
	}

	// Idempotent: if remote already has this SHA, no-op.
	const ls = runGit(projectRoot, "ls-remote", [remoteName, `refs/heads/${featureBranch}`]);
	if (ls.status === 0) {
		const remoteSha = (ls.stdout.trim().split(/\s+/)[0] || "").toLowerCase();
		if (remoteSha === expected) {
			return {
				remoteName,
				featureBranch,
				headSha: expected,
				alreadyUpToDate: true,
			};
		}
	}

	// Non-force push of the single feature branch.
	const push = runGit(projectRoot, "push", [
		remoteName,
		`refs/heads/${featureBranch}:refs/heads/${featureBranch}`,
	]);
	if (push.status !== 0) {
		throw createNormalizedError({
			code: errorCodes.ADAPTER_ERROR,
			message: redactSecrets(
				`Failed to push ${featureBranch} to ${remoteName}: ${push.stderr.trim().slice(0, 300)}`,
			),
			httpStatus: 502,
		});
	}

	return {
		remoteName,
		featureBranch,
		headSha: expected,
		alreadyUpToDate: false,
	};
}
