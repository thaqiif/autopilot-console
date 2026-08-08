/**
 * RED tests for constrained GitGateway (requirement 10).
 * Disposable local remotes only — no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliGitGateway } from "./cli-git-gateway";
import type { GitGateway } from "./git-gateway";
import {
	cleanupTempRoots,
	git,
	initTempRepository,
	writeRelativeFile,
} from "./testing/temp-repository";

afterEach(async () => {
	await cleanupTempRoots();
});

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function gateway(): GitGateway {
	return new CliGitGateway();
}

const expectedRepo = {
	owner: "acme",
	repository: "widget",
	fullName: "acme/widget",
} as const;

describe("GitGateway public API surface", () => {
	test("exposes only preflight, ensureFeatureBranch, observeCommits, pushFeatureBranch", () => {
		const g = gateway() as unknown as Record<string, unknown>;
		expect(typeof g.preflight).toBe("function");
		expect(typeof g.ensureFeatureBranch).toBe("function");
		expect(typeof g.observeCommits).toBe("function");
		expect(typeof g.pushFeatureBranch).toBe("function");
		for (const verb of [
			"forcePush",
			"resetHard",
			"clean",
			"deleteBranch",
			"rewriteHistory",
			"runArbitrary",
			"exec",
			"raw",
		]) {
			expect(g[verb]).toBeUndefined();
		}
	});
});

describe("preflight", () => {
	test("accepts clean repo with matching remote identity, base, and task", async () => {
		const body = '{"requirements":[]}\n';
		const repo = await initTempRepository({
			initialFiles: { "README.md": "# fixture\n", "docs/tasks/demo.json": body },
		});
		const g = gateway();
		const result = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "docs/tasks/demo.json",
			taskChecksum: sha256(body),
			allowTaskArtifactDirty: true,
		});
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		expect(result.repository.fullName).toBe("acme/widget");
		expect(result.remoteUrl).not.toMatch(/ghp_|:[^/]+@/);
	});

	test("rejects non-git directory", async () => {
		const repo = await initTempRepository();
		const plain = join(repo.path, "..", "plain");
		await mkdir(plain, { recursive: true });
		const g = gateway();
		const result = await g.preflight({
			projectRoot: plain,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: "main",
			featureBranch: "feature/feat-1-demo",
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.code === "NOT_A_GIT_REPOSITORY")).toBe(true);
	});

	test("rejects missing remote", async () => {
		const repo = await initTempRepository();
		git(repo.path, ["remote", "remove", "origin"]);
		const g = gateway();
		const result = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.code === "REMOTE_MISSING")).toBe(true);
	});

	test("rejects remote identity mismatch without leaking credentials", async () => {
		const repo = await initTempRepository();
		git(repo.path, [
			"remote",
			"set-url",
			"origin",
			"https://user:ghp_supersecrettoken1234567890abcd@github.com/other/repo.git",
		]);
		const g = gateway();
		const result = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.code === "REMOTE_IDENTITY_MISMATCH")).toBe(true);
		const blob = JSON.stringify(result);
		expect(blob).not.toContain("ghp_supersecrettoken");
		expect(blob).not.toContain("user:ghp");
	});

	test("rejects missing development branch on remote", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const result = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: "does-not-exist-on-remote",
			featureBranch: "feature/feat-1-demo",
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.code === "DEVELOPMENT_BRANCH_MISSING")).toBe(true);
	});

	test("rejects unrelated dirty worktree while allowing approved task dirtiness", async () => {
		const body = '{"requirements":[]}\n';
		const repo = await initTempRepository({
			initialFiles: {
				"README.md": "# fixture\n",
				"docs/tasks/demo.json": body,
			},
		});
		const g = gateway();

		await writeFile(join(repo.path, "unrelated.txt"), "dirty\n", "utf8");
		await writeFile(
			join(repo.path, "docs/tasks/demo.json"),
			'{"requirements":[{"id":"1"}]}\n',
			"utf8",
		);

		const dirty = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "docs/tasks/demo.json",
			taskChecksum: sha256('{"requirements":[{"id":"1"}]}\n'),
			allowTaskArtifactDirty: true,
		});
		expect(dirty.ok).toBe(false);
		expect(dirty.failures.some((f) => f.code === "DIRTY_WORKTREE")).toBe(true);

		// Remove unrelated untracked; leave only task dirty.
		git(repo.path, ["clean", "-fd"]);
		await writeFile(
			join(repo.path, "docs/tasks/demo.json"),
			'{"requirements":[{"id":"1"}]}\n',
			"utf8",
		);
		const taskOnly = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "docs/tasks/demo.json",
			taskChecksum: sha256('{"requirements":[{"id":"1"}]}\n'),
			allowTaskArtifactDirty: true,
		});
		expect(taskOnly.ok).toBe(true);
		expect(taskOnly.failures.map((f) => f.code)).not.toContain("DIRTY_WORKTREE");
	});

	test("rejects task checksum mismatch", async () => {
		const body = '{"requirements":[]}\n';
		const repo = await initTempRepository({
			initialFiles: {
				"README.md": "# fixture\n",
				"docs/tasks/demo.json": body,
			},
		});
		const g = gateway();
		const result = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "docs/tasks/demo.json",
			taskChecksum: "0".repeat(64),
			allowTaskArtifactDirty: true,
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.code === "TASK_CHECKSUM_MISMATCH")).toBe(true);
	});

	test("rejects absolute or traversal task paths", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const abs = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "/etc/passwd.json",
			taskChecksum: "0".repeat(64),
		});
		expect(abs.ok).toBe(false);
		expect(abs.failures.some((f) => f.code === "TASK_PATH_INVALID")).toBe(true);

		const trav = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "../escape.json",
			taskChecksum: "0".repeat(64),
		});
		expect(trav.ok).toBe(false);
		expect(trav.failures.some((f) => f.code === "TASK_PATH_INVALID")).toBe(true);
	});

	test("rejects feature branch name that is not feature/<id>-<slug> shape", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const result = await g.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "hotfix/unsafe",
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.code === "FEATURE_BRANCH_MISMATCH")).toBe(true);
	});
});

describe("ensureFeatureBranch", () => {
	test("first attempt creates feature branch from remote development tip", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const branch = "feature/feat-1-demo";
		const created = await g.ensureFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			developmentBranch: repo.developmentBranch,
			featureBranch: branch,
			createIfMissing: true,
		});
		expect(created.created).toBe(true);
		expect(created.featureBranch).toBe(branch);
		expect(created.headSha).toMatch(/^[0-9a-f]{40}$/);
		expect(git(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
		const tip = git(repo.path, ["rev-parse", "HEAD"]);
		expect(tip).toBe(created.headSha);
		const base = git(repo.path, ["rev-parse", `origin/${repo.developmentBranch}`]);
		expect(tip).toBe(base);
	});

	test("retry reuses existing feature branch without recreating", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const branch = "feature/feat-1-demo";
		await g.ensureFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			developmentBranch: repo.developmentBranch,
			featureBranch: branch,
			createIfMissing: true,
		});
		await writeFile(join(repo.path, "work.txt"), "progress\n", "utf8");
		git(repo.path, ["add", "work.txt"]);
		git(repo.path, ["commit", "-m", "progress"]);
		const afterCommit = git(repo.path, ["rev-parse", "HEAD"]);

		const second = await g.ensureFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			developmentBranch: repo.developmentBranch,
			featureBranch: branch,
			createIfMissing: false,
		});
		expect(second.created).toBe(false);
		expect(second.headSha).toBe(afterCommit);
		expect(git(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);
	});

	test("createIfMissing false fails when branch absent", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		await expect(
			g.ensureFeatureBranch({
				projectRoot: repo.path,
				remoteName: "origin",
				developmentBranch: repo.developmentBranch,
				featureBranch: "feature/feat-1-missing",
				createIfMissing: false,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});
});

describe("observeCommits", () => {
	test("returns bounded commits on verified feature branch only", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const branch = "feature/feat-1-demo";
		await g.ensureFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			developmentBranch: repo.developmentBranch,
			featureBranch: branch,
			createIfMissing: true,
		});
		for (let i = 0; i < 3; i++) {
			await writeFile(join(repo.path, `c${i}.txt`), `${i}\n`, "utf8");
			git(repo.path, ["add", `c${i}.txt`]);
			git(repo.path, ["commit", "-m", `commit ${i}`]);
		}
		const commits = await g.observeCommits({
			projectRoot: repo.path,
			featureBranch: branch,
			limit: 2,
		});
		expect(commits).toHaveLength(2);
		expect(commits[0]?.subject).toContain("commit 2");
		expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
		expect(commits.every((c) => typeof c.hash === "string")).toBe(true);
	});
});

describe("pushFeatureBranch", () => {
	test("pushes feature HEAD to remote feature branch and is idempotent", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const branch = "feature/feat-1-demo";
		await g.ensureFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			developmentBranch: repo.developmentBranch,
			featureBranch: branch,
			createIfMissing: true,
		});
		await writeFile(join(repo.path, "feature.txt"), "x\n", "utf8");
		git(repo.path, ["add", "feature.txt"]);
		git(repo.path, ["commit", "-m", "feature work"]);
		const head = git(repo.path, ["rev-parse", "HEAD"]);

		const first = await g.pushFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			featureBranch: branch,
			expectedHeadSha: head,
		});
		expect(first.alreadyUpToDate).toBe(false);
		expect(first.headSha).toBe(head);
		expect(git(repo.path, ["ls-remote", "origin", `refs/heads/${branch}`])).toContain(head);

		const second = await g.pushFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			featureBranch: branch,
			expectedHeadSha: head,
		});
		expect(second.alreadyUpToDate).toBe(true);
		expect(second.headSha).toBe(head);
	});

	test("rejects push when expectedHeadSha mismatches", async () => {
		const repo = await initTempRepository();
		const g = gateway();
		const branch = "feature/feat-1-demo";
		await g.ensureFeatureBranch({
			projectRoot: repo.path,
			remoteName: "origin",
			developmentBranch: repo.developmentBranch,
			featureBranch: branch,
			createIfMissing: true,
		});
		await expect(
			g.pushFeatureBranch({
				projectRoot: repo.path,
				remoteName: "origin",
				featureBranch: branch,
				expectedHeadSha: "0".repeat(40),
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});
});

describe("forbidden operations", () => {
	test("cli adapter source has no force push, hard reset, clean, branch delete, or shell", async () => {
		const src = await readFile(new URL("./cli-git-gateway.ts", import.meta.url), "utf8");
		expect(src).not.toMatch(/--force(?!-with-lease)/);
		expect(src).not.toMatch(/reset\s+--hard/);
		expect(src).not.toMatch(/\bclean\b/);
		expect(src).not.toMatch(/branch\s+-D/);
		expect(src).not.toMatch(/push\s+.*--force/);
		expect(src).not.toMatch(/shell:\s*true/);
		expect(src).not.toMatch(/\/bin\/sh/);
		// No generic command escape hatch accepting caller argv
		expect(src).not.toMatch(/runArbitrary|execGit\(|rawCommand/);
		void writeRelativeFile;
	});
});
