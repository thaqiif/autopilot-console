/**
 * Idempotent safe push of the verified feature branch HEAD (no force).
 */

import { createNormalizedError, errorCodes } from "../../shared/src/errors/normalized-error";
import { redactSecrets } from "../../shared/src/security/redaction";
import { localBranchExists, runGit, runGitOk } from "./cli-runner";
import { preconditionError } from "./errors";
import type { SafePushRequest, SafePushResult } from "./git-gateway";

export async function pushFeatureBranch(request: SafePushRequest): Promise<SafePushResult> {
	const { projectRoot, remoteName, featureBranch, expectedHeadSha } = request;

	if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
		preconditionError("expectedHeadSha must be a 40-char commit SHA");
	}
	if (!localBranchExists(projectRoot, featureBranch)) {
		preconditionError(`Feature branch ${featureBranch} does not exist`);
	}

	const expected = expectedHeadSha.toLowerCase();
	const branchTip = runGitOk(projectRoot, "rev-parse", [featureBranch]).toLowerCase();
	if (branchTip !== expected) {
		preconditionError("Feature branch tip does not match expectedHeadSha");
	}

	const head = runGitOk(projectRoot, "rev-parse", ["HEAD"]).toLowerCase();
	if (head !== expected) {
		runGitOk(projectRoot, "checkout", [featureBranch]);
		if (runGitOk(projectRoot, "rev-parse", ["HEAD"]).toLowerCase() !== expected) {
			preconditionError("HEAD does not match expectedHeadSha after checkout");
		}
	}

	const ls = runGit(projectRoot, "ls-remote", [remoteName, `refs/heads/${featureBranch}`]);
	if (ls.status === 0) {
		const remoteSha = (ls.stdout.trim().split(/\s+/)[0] || "").toLowerCase();
		if (remoteSha === expected) {
			return { remoteName, featureBranch, headSha: expected, alreadyUpToDate: true };
		}
	}

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

	return { remoteName, featureBranch, headSha: expected, alreadyUpToDate: false };
}
