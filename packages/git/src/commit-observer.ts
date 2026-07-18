/**
 * Bounded commit observation on a verified feature branch.
 * Commit subjects are diagnostic text only — never interpreted as commands.
 */

import { redactSecrets } from "../../shared/src/security/redaction";
import { localBranchExists, runGitOk } from "./cli-runner";
import { preconditionError } from "./errors";
import type { CommitObservation, ObserveCommitsRequest } from "./git-gateway";

export async function observeCommits(request: ObserveCommitsRequest): Promise<CommitObservation[]> {
	const limit = Math.min(Math.max(request.limit ?? 50, 1), 200);
	const { projectRoot, featureBranch, afterSha } = request;

	if (!localBranchExists(projectRoot, featureBranch)) {
		preconditionError(`Feature branch ${featureBranch} does not exist`);
	}

	const range = afterSha ? `${afterSha}..${featureBranch}` : featureBranch;
	const out = runGitOk(projectRoot, "log", [
		range,
		"-n",
		String(limit),
		"--format=%H%x09%at%x09%s",
	]);
	if (out.length === 0) return [];

	const commits: CommitObservation[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		const firstTab = line.indexOf("\t");
		const secondTab = line.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const hash = line.slice(0, firstTab);
		const at = line.slice(firstTab + 1, secondTab);
		const subject = line.slice(secondTab + 1);
		if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
		commits.push({
			hash: hash.toLowerCase(),
			subject: redactSecrets(subject),
			authoredAt: Number.isFinite(Number(at))
				? new Date(Number(at) * 1000).toISOString()
				: undefined,
		});
	}
	return commits;
}
