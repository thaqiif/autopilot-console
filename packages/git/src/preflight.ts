/**
 * Registration/run preflight: path, repo, remote identity, base, task, feature branch shape.
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolveTaskPath } from "../../shared/src/fs/task-path";
import {
	parseGitHubRemote,
	type RepositoryIdentity,
} from "../../shared/src/git/repository-identity";
import { redactSecrets } from "../../shared/src/security/redaction";
import { remoteTrackingExists, runGit } from "./cli-runner";
import { FEATURE_BRANCH_RE } from "./errors";
import type {
	GitPreflightFailureCode,
	GitPreflightRequest,
	GitPreflightResult,
	RepositoryIdentityView,
} from "./git-gateway";

function fail(
	code: GitPreflightFailureCode,
	message: string,
): { code: GitPreflightFailureCode; message: string } {
	return { code, message: redactSecrets(message) };
}

function sha256Hex(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

function toView(id: RepositoryIdentity): RepositoryIdentityView {
	return { owner: id.owner, repository: id.repository, fullName: id.fullName };
}

function safeRemoteUrlForResult(url: string): string {
	try {
		const u = new URL(url);
		if (u.username || u.password) {
			u.username = "";
			u.password = "";
		}
		return u.toString().replace(/\/$/, "") || u.toString();
	} catch {
		return redactSecrets(url);
	}
}

function listDirtyPaths(cwd: string): string[] {
	const r = runGit(cwd, "status", ["--porcelain", "-uall"]);
	if (r.status !== 0) return ["?"];
	return r.stdout
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.map((line) => {
			const rest = line.slice(3);
			const arrow = rest.indexOf(" -> ");
			const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
			return path.replace(/^"|"$/g, "");
		});
}

function onlyTaskDirty(dirty: string[], taskRelative: string): boolean {
	const norm = taskRelative.replace(/\\/g, "/");
	return dirty.length > 0 && dirty.every((p) => p.replace(/\\/g, "/") === norm);
}

function emptyResult(
	request: GitPreflightRequest,
	failures: Array<{ code: GitPreflightFailureCode; message: string }>,
	remoteUrl: string,
	repository: RepositoryIdentityView,
	headBranch: string | null,
	headSha: string | null,
): GitPreflightResult {
	return {
		ok: false,
		projectRoot: request.projectRoot,
		remoteName: request.remoteName,
		remoteUrl: safeRemoteUrlForResult(remoteUrl),
		repository,
		developmentBranch: request.developmentBranch,
		featureBranch: request.featureBranch,
		headBranch,
		headSha,
		failures,
	};
}

/**
 * Validate repository readiness without mutating refs (fetch is allowed).
 */
export async function runPreflight(request: GitPreflightRequest): Promise<GitPreflightResult> {
	const failures: Array<{ code: GitPreflightFailureCode; message: string }> = [];
	let remoteUrl = "";
	let repository: RepositoryIdentityView = {
		owner: request.expectedRepository.owner,
		repository: request.expectedRepository.repository,
		fullName: request.expectedRepository.fullName,
	};
	let headBranch: string | null = null;
	let headSha: string | null = null;

	let projectRoot: string;
	try {
		projectRoot = await realpath(request.projectRoot);
	} catch {
		failures.push(fail("PATH_INVALID", "Project root does not exist or is not accessible"));
		return emptyResult(request, failures, remoteUrl, repository, headBranch, headSha);
	}

	const isGit = runGit(projectRoot, "rev-parse", ["--is-inside-work-tree"]);
	if (isGit.status !== 0 || isGit.stdout.trim() !== "true") {
		failures.push(fail("NOT_A_GIT_REPOSITORY", "Path is not a Git worktree"));
		return emptyResult(request, failures, remoteUrl, repository, headBranch, headSha);
	}

	// Prefer configured remote.<name>.url (not insteadOf-resolved get-url).
	const remoteConfig = runGit(projectRoot, "config", ["--get", `remote.${request.remoteName}.url`]);
	if (remoteConfig.status !== 0 || remoteConfig.stdout.trim().length === 0) {
		failures.push(fail("REMOTE_MISSING", `Remote ${request.remoteName} is not configured`));
	} else {
		remoteUrl = remoteConfig.stdout.trim();
		try {
			const parsed = parseGitHubRemote(remoteUrl);
			repository = toView(parsed);
			if (
				parsed.owner !== request.expectedRepository.owner ||
				parsed.repository !== request.expectedRepository.repository
			) {
				failures.push(
					fail(
						"REMOTE_IDENTITY_MISMATCH",
						`Remote repository ${parsed.fullName} does not match expected ${request.expectedRepository.fullName}`,
					),
				);
			}
		} catch {
			failures.push(
				fail(
					"REMOTE_IDENTITY_MISMATCH",
					"Remote URL is not a supported GitHub remote or does not match expected identity",
				),
			);
		}
	}

	if (!FEATURE_BRANCH_RE.test(request.featureBranch)) {
		failures.push(
			fail("FEATURE_BRANCH_MISMATCH", "Feature branch must match feature/<feature-id>-<slug>"),
		);
	}

	if (failures.every((f) => f.code !== "REMOTE_MISSING")) {
		runGit(projectRoot, "fetch", [request.remoteName, request.developmentBranch, "--prune"]);
		if (!remoteTrackingExists(projectRoot, request.remoteName, request.developmentBranch)) {
			failures.push(
				fail(
					"DEVELOPMENT_BRANCH_MISSING",
					`Development branch ${request.developmentBranch} not found on remote ${request.remoteName}`,
				),
			);
		}
	}

	if (request.taskRelativePath) {
		try {
			const resolved = await resolveTaskPath(projectRoot, request.taskRelativePath);
			const checksum = sha256Hex(await readFile(resolved.absolute));
			if (request.taskChecksum && checksum !== request.taskChecksum) {
				failures.push(
					fail(
						"TASK_CHECKSUM_MISMATCH",
						"Task artifact checksum does not match the approved snapshot",
					),
				);
			}
		} catch {
			failures.push(
				fail("TASK_PATH_INVALID", "Task path is invalid, missing, or escapes the project"),
			);
		}
	}

	const dirty = listDirtyPaths(projectRoot);
	if (dirty.length > 0) {
		const allowTask = request.allowTaskArtifactDirty === true && request.taskRelativePath;
		if (!(allowTask && onlyTaskDirty(dirty, request.taskRelativePath as string))) {
			failures.push(
				fail("DIRTY_WORKTREE", "Worktree has unrelated staged, unstaged, or untracked changes"),
			);
		}
	}

	const headShaR = runGit(projectRoot, "rev-parse", ["HEAD"]);
	if (headShaR.status === 0) headSha = headShaR.stdout.trim();
	const headBr = runGit(projectRoot, "rev-parse", ["--abbrev-ref", "HEAD"]);
	if (headBr.status === 0 && headBr.stdout.trim() !== "HEAD") {
		headBranch = headBr.stdout.trim();
	}

	return {
		ok: failures.length === 0,
		projectRoot,
		remoteName: request.remoteName,
		remoteUrl: safeRemoteUrlForResult(remoteUrl),
		repository,
		developmentBranch: request.developmentBranch,
		featureBranch: request.featureBranch,
		headBranch,
		headSha,
		failures,
	};
}
