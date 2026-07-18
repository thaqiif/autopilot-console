/**
 * Disposable local Git repositories with optional bare remotes for integration tests.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

export async function createTempRoot(prefix = "git-fixture-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

export async function cleanupTempRoots(): Promise<void> {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
	}
	return (r.stdout || "").trim();
}

export interface TempRepository {
	/** Working clone path (project root). */
	path: string;
	/** Bare remote path. */
	remotePath: string;
	/** Remote name, always origin in fixtures. */
	remoteName: "origin";
	/** Development branch name. */
	developmentBranch: string;
}

export interface InitTempRepositoryOptions {
	developmentBranch?: string;
	owner?: string;
	repository?: string;
	initialFiles?: Record<string, string>;
	/**
	 * When true (default), origin URL is https://github.com/{owner}/{repo}.git and
	 * url.<bare>.insteadOf rewrites fetch/push to the local bare remote so identity
	 * parsing and network-free Git operations both work.
	 */
	githubShapedRemote?: boolean;
}

/**
 * Create bare remote + working clone with one commit on the development branch.
 * By default origin is github-shaped with insteadOf → local bare (disposable, no network).
 */
export async function initTempRepository(
	options: InitTempRepositoryOptions = {},
): Promise<TempRepository> {
	const developmentBranch = options.developmentBranch ?? "main";
	const owner = options.owner ?? "acme";
	const repository = options.repository ?? "widget";
	const githubShaped = options.githubShapedRemote !== false;
	const root = await createTempRoot();
	const remotePath = join(root, "remote.git");
	const workPath = join(root, "work");

	git(root, ["init", "--bare", remotePath]);

	await mkdir(workPath, { recursive: true });
	git(workPath, ["init", "-b", developmentBranch]);
	git(workPath, ["config", "user.email", "test@example.com"]);
	git(workPath, ["config", "user.name", "Git Fixture"]);
	git(workPath, ["config", "commit.gpgsign", "false"]);

	const files = options.initialFiles ?? { "README.md": "# fixture\n" };
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(workPath, rel);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
	git(workPath, ["add", "."]);
	git(workPath, ["commit", "-m", "init"]);

	if (githubShaped) {
		const githubUrl = `https://github.com/${owner}/${repository}.git`;
		// insteadOf must end with / for path prefix rewrite in some git versions;
		// map exact URL to local bare.
		git(workPath, ["config", `url.${remotePath}.insteadOf`, githubUrl]);
		git(workPath, ["remote", "add", "origin", githubUrl]);
	} else {
		git(workPath, ["remote", "add", "origin", remotePath]);
	}
	git(workPath, ["push", "-u", "origin", developmentBranch]);

	return {
		path: workPath,
		remotePath,
		remoteName: "origin",
		developmentBranch,
	};
}

export async function writeRelativeFile(
	repoPath: string,
	relative: string,
	content: string,
): Promise<string> {
	const abs = join(repoPath, relative);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content, "utf8");
	return relative;
}
