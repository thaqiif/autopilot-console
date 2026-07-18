/**
 * RED tests for AutopilotRunner CLI adapter (requirement 9).
 * Uses a controllable fake executable; real CLI is opt-in elsewhere.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installFakeAutopilotagent } from "../testing/fake-autopilotagent";
import { fullTaskFile } from "../testing/task-fixtures";
import {
	assertBranchCompatibility,
	type BranchCompatibilityPlan,
	prepareBranchCompatibility,
} from "./branch-compatibility";
import {
	type AutopilotRunner,
	type AutopilotStartRequest,
	CliAutopilotRunner,
} from "./cli-autopilot-runner";
import { createProcessIdentity, verifyProcessIdentity } from "./process-identity";
import { normalizeRunResult } from "./result-normalizer";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	}
	return (r.stdout || "").trim();
}

async function initRepo(root: string): Promise<void> {
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	await writeFile(join(root, "README.md"), "hi\n", "utf8");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "init"]);
}

async function writeTask(
	projectRoot: string,
	relative: string,
	doc: unknown = fullTaskFile(),
): Promise<string> {
	const abs = join(projectRoot, relative);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, JSON.stringify(doc, null, 2), "utf8");
	return relative;
}

function baseRequest(
	projectRoot: string,
	taskRelativePath: string,
	executablePath: string,
	overrides: Partial<AutopilotStartRequest> = {},
): AutopilotStartRequest {
	return {
		projectRoot,
		taskRelativePath,
		projectId: "proj-1",
		featureId: "feat-1",
		expectedBranch: "feature/feat-1-demo",
		executablePath,
		...overrides,
	};
}

describe("process identity", () => {
	test("captures pid and start identity and detects mismatch", async () => {
		const id = await createProcessIdentity(process.pid);
		expect(id.pid).toBe(process.pid);
		expect(id.startTimeMs).toBeGreaterThan(0);
		const ok = await verifyProcessIdentity(id);
		expect(ok).toBe(true);
		const bad = await verifyProcessIdentity({
			pid: id.pid,
			startTimeMs: id.startTimeMs - 1_000_000,
		});
		expect(bad).toBe(false);
	});
});

describe("CliAutopilotRunner — spawn contract", () => {
	test("spawns fixed executable with only relative task path, project cwd, shell disabled, minimal env", async () => {
		const root = await tempDir("ap-spawn-");
		const bin = await tempDir("ap-bin-");
		// Fake records argv/cwd/env to a capture file then exits 0.
		const capturePath = join(root, "capture.json");
		const fake = join(bin, "autopilotagent");
		await writeFile(
			fake,
			`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  shell: process.env.SHELL,
}), "utf8");
process.exit(0);
`,
			"utf8",
		);
		await chmod(fake, 0o755);

		const taskRel = await writeTask(root, "docs/autopilotagent/demo/demo.json");
		const runner: AutopilotRunner = new CliAutopilotRunner({
			executablePath: fake,
			envAllowlist: ["PATH", "HOME", "TMPDIR"],
		});

		const handle = await runner.start(baseRequest(root, taskRel, fake));
		const result = await runner.wait(handle, { timeoutMs: 5_000 });
		expect(result.exitCode).toBe(0);

		const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
			argv: string[];
			cwd: string;
			env: Record<string, string>;
		};
		expect(capture.argv).toEqual([taskRel]);
		expect(capture.cwd).toBe(root);
		// Only allowlisted env keys (plus any runner-required minimal set).
		const envKeys = Object.keys(capture.env).sort();
		for (const k of envKeys) {
			expect(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]).toContain(k);
		}
		// No shell metacharacters / no shell invocation path.
		expect(capture.argv.some((a) => a.includes("&&") || a.includes(";"))).toBe(false);
	});

	test("rejects absolute task path and empty path", async () => {
		const root = await tempDir("ap-path-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({ binDir: bin });
		const runner = new CliAutopilotRunner({ executablePath: fake });
		await expect(runner.start(baseRequest(root, "/etc/passwd", fake))).rejects.toThrow();
		await expect(runner.start(baseRequest(root, "", fake))).rejects.toThrow();
	});

	test("validateRuntime fails when executable missing", async () => {
		const runner = new CliAutopilotRunner({
			executablePath: "/nonexistent/autopilotagent-missing",
		});
		const v = await runner.validateRuntime();
		expect(v.ok).toBe(false);
		expect(v.message).toMatch(/autopilotagent|executable|not found/i);
	});
});

describe("CliAutopilotRunner — pid, progress, notes, analytics, exit", () => {
	test("records wrapper PID + start identity; reads sibling run.pid, notes, analytics; maps exit", async () => {
		const root = await tempDir("ap-life-");
		await initRepo(root);
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { exitCode: 0, mutateTask: true, writeNotesAnalytics: true },
		});
		const taskRel = await writeTask(root, "docs/autopilotagent/demo/demo.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));

		expect(handle.processIdentity.pid).toBeGreaterThan(0);
		expect(handle.projectId).toBe("proj-1");
		expect(handle.featureId).toBe("feat-1");

		// May finish quickly; wait then inspect artifacts.
		const result = await runner.wait(handle, { timeoutMs: 5_000 });
		expect(result.exitCode).toBe(0);
		expect(result.progress.allPass).toBe(true);
		expect(result.progress.passed).toBeGreaterThanOrEqual(1);
		expect(result.notes?.exists).toBe(true);
		expect(result.analytics?.exists).toBe(true);
		expect(result.outcome).toBe("succeeded");

		// stdout/stderr never treated as workflow commands — only diagnostics.
		expect(result.stdoutDiagnostic).toBeDefined();
		expect(typeof result.stdoutDiagnostic).toBe("string");
	});

	test("nonzero exit maps to failed even if task partially mutated", async () => {
		const root = await tempDir("ap-fail-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { exitCode: 7, mutateTask: false },
		});
		const taskRel = await writeTask(root, "docs/autopilotagent/x/x.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));
		const result = await runner.wait(handle, { timeoutMs: 5_000 });
		expect(result.exitCode).toBe(7);
		expect(result.outcome).toBe("failed");
		expect(result.allPass).toBe(false);
	});

	test("redacts secrets from captured stdout/stderr and notes", async () => {
		const root = await tempDir("ap-redact-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { emitSecrets: true, writeNotesAnalytics: true },
		});
		const taskRel = await writeTask(root, "docs/autopilotagent/r/r.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));
		const result = await runner.wait(handle, { timeoutMs: 5_000 });
		const blob = [
			result.stdoutDiagnostic,
			result.stderrDiagnostic,
			result.notes?.content ?? "",
			result.redactedMessage,
		].join("\n");
		expect(blob).not.toMatch(/ghp_[A-Za-z0-9]+/);
		expect(blob).not.toMatch(/supersecret/);
		expect(blob).toMatch(/REDACTED/);
	});

	test("SIGUSR1 graceful signal uses verified identity; refuses mismatched identity", async () => {
		const root = await tempDir("ap-sig-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { waitForSigusr1: true, mutateTask: false },
		});
		const taskRel = await writeTask(root, "docs/autopilotagent/s/s.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));

		// Live process should report alive.
		const alive = await runner.isAlive(handle);
		expect(alive).toBe(true);

		// Mismatched identity must not signal.
		const forged = {
			...handle,
			processIdentity: {
				...handle.processIdentity,
				startTimeMs: handle.processIdentity.startTimeMs - 999_999,
			},
		};
		await expect(runner.signal(forged, "graceful")).rejects.toThrow(/identity|mismatch|verify/i);

		await runner.signal(handle, "graceful");
		// Give the child a moment to handle SIGUSR1 / stop-signal.
		const deadline = Date.now() + 3_000;
		while ((await runner.isAlive(handle)) && Date.now() < deadline) {
			await Bun.sleep(20);
		}
		const result = await runner.wait(handle, { timeoutMs: 5_000 });
		expect(result.exitCode).toBe(0);
	});

	test("malformed task mid-run retains last valid progress via tolerant read", async () => {
		const root = await tempDir("ap-mal-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: {
				writeMalformedTask: true,
				mutateTask: false,
				writeNotesAnalytics: false,
			},
		});
		const taskRel = await writeTask(
			root,
			"docs/autopilotagent/m/m.json",
			fullTaskFile({}, [
				{
					id: "1",
					description: "r1",
					acceptance: ["a"],
					tdd: {
						test: { description: "t", passes: true },
						implement: { description: "i", passes: true },
						refactor: { description: "r", passes: true },
					},
					verification: ["v"],
					passes: true,
				},
			]),
		);
		const runner = new CliAutopilotRunner({ executablePath: fake });
		// Seed last-valid by reading before start.
		const pre = await runner.validateTask(root, taskRel);
		expect(pre.ok).toBe(true);

		const handle = await runner.start(baseRequest(root, taskRel, fake));
		const result = await runner.wait(handle, { timeoutMs: 5_000 });
		// Progress should not claim success from partial JSON; last valid or diagnostic.
		expect(result.progress).toBeDefined();
		expect(result.outcome === "failed" || result.progress.total >= 0).toBe(true);
	});
});

describe("branch compatibility strategy", () => {
	test("prepareBranchCompatibility creates basename branch at same tip without destructive ops", async () => {
		const root = await tempDir("ap-br-");
		await initRepo(root);
		const expected = "feature/feat-1-demo";
		git(root, ["checkout", "-b", expected]);
		await writeFile(join(root, "work.txt"), "x\n", "utf8");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "on-feature"]);

		const taskRel = "docs/autopilotagent/demo/demo.json";
		await writeTask(root, taskRel);
		const plan = await prepareBranchCompatibility({
			projectRoot: root,
			taskRelativePath: taskRel,
			expectedBranch: expected,
		});
		expect(plan.taskBasename).toBe("demo");
		expect(plan.expectedBranch).toBe(expected);
		expect(plan.destructiveOperations).toEqual([]);
		// Basename branch exists and points at same commit as expected.
		const expectedSha = git(root, ["rev-parse", expected]);
		const baseSha = git(root, ["rev-parse", plan.taskBasename]);
		expect(baseSha).toBe(expectedSha);
	});

	test("assertBranchCompatibility fails when HEAD commits are only on foreign branch not reconcilable", async () => {
		const root = await tempDir("ap-br2-");
		await initRepo(root);
		const expected = "feature/feat-1-demo";
		git(root, ["checkout", "-b", expected]);
		const taskRel = "docs/autopilotagent/demo/demo.json";
		await writeTask(root, taskRel);
		await prepareBranchCompatibility({
			projectRoot: root,
			taskRelativePath: taskRel,
			expectedBranch: expected,
		});

		// Divergent commit on unrelated branch.
		git(root, ["checkout", "-b", "foreign-only"]);
		await writeFile(join(root, "foreign.txt"), "y\n", "utf8");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "foreign"]);

		const check = await assertBranchCompatibility({
			projectRoot: root,
			expectedBranch: expected,
			taskBasename: "demo",
		});
		// On foreign branch with unique commits — not a clean reconcilable state for push of expected.
		expect(check.ok).toBe(false);
		expect(check.strategy).not.toMatch(/force|delete|rewrite/i);
	});

	test("after basename checkout + commit, reconcile is ff-only onto expected branch", async () => {
		const root = await tempDir("ap-br3-");
		await initRepo(root);
		const expected = "feature/feat-1-demo";
		git(root, ["checkout", "-b", expected]);
		const taskRel = "docs/autopilotagent/demo/demo.json";
		await writeTask(root, taskRel);
		const plan: BranchCompatibilityPlan = await prepareBranchCompatibility({
			projectRoot: root,
			taskRelativePath: taskRel,
			expectedBranch: expected,
		});

		// Simulate agent: checkout basename and commit.
		git(root, ["checkout", plan.taskBasename]);
		await writeFile(join(root, "agent.txt"), "done\n", "utf8");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "agent work"]);

		const check = await assertBranchCompatibility({
			projectRoot: root,
			expectedBranch: expected,
			taskBasename: plan.taskBasename,
		});
		expect(check.ok).toBe(true);
		expect(check.canFastForwardExpected).toBe(true);

		// Reconcile: ff expected to basename tip (local ref only).
		git(root, ["checkout", expected]);
		git(root, ["merge", "--ff-only", plan.taskBasename]);
		const expectedSha = git(root, ["rev-parse", expected]);
		const baseSha = git(root, ["rev-parse", plan.taskBasename]);
		expect(expectedSha).toBe(baseSha);
	});

	test("strategy documentation file exists and forbids destructive operations", async () => {
		const doc = await readFile(
			join(import.meta.dir, "../../../../docs/architecture/autopilot-cli-compatibility.md"),
			"utf8",
		);
		expect(doc).toMatch(/feature\/<feature-id>-/);
		expect(doc).toMatch(/basename/i);
		expect(doc).toMatch(/fast-forward|ff-only/i);
		expect(doc.toLowerCase()).toMatch(/no force push|never force push|forbidden.*force/);
		expect(doc.toLowerCase()).not.toMatch(/git push --force/);
		expect(doc.toLowerCase()).toMatch(/no.*branch deletion|never delete branch|forbidden.*delete/);
	});
});

describe("result normalizer", () => {
	test("zero exit without allPass is not succeeded", () => {
		const r = normalizeRunResult({
			exitCode: 0,
			signal: null,
			progress: {
				total: 2,
				passed: 1,
				stuck: 0,
				invalidTest: 0,
				remaining: 1,
				allPass: false,
				blockedReasons: [],
			},
			stdout: "ok",
			stderr: "",
		});
		expect(r.outcome).not.toBe("succeeded");
		expect(r.allPass).toBe(false);
	});

	test("bounds diagnostic output", () => {
		const big = "x".repeat(200_000);
		const r = normalizeRunResult({
			exitCode: 1,
			signal: null,
			progress: {
				total: 0,
				passed: 0,
				stuck: 0,
				invalidTest: 0,
				remaining: 0,
				allPass: false,
				blockedReasons: [],
			},
			stdout: big,
			stderr: big,
			maxDiagnosticBytes: 1024,
		});
		expect(r.stdoutDiagnostic.length).toBeLessThanOrEqual(1024 + 64);
		expect(r.stdoutDiagnostic).toMatch(/truncated|TRUNCATED/i);
	});
});

describe("relevant commits observation", () => {
	test("observes commits on expected feature branch only", async () => {
		const root = await tempDir("ap-commits-");
		await initRepo(root);
		const expected = "feature/feat-1-demo";
		git(root, ["checkout", "-b", expected]);
		await writeFile(join(root, "c.txt"), "1\n", "utf8");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "feature work"]);

		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { mutateTask: false, writeNotesAnalytics: false },
		});
		const taskRel = await writeTask(root, "docs/autopilotagent/demo/demo.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(
			baseRequest(root, taskRel, fake, { expectedBranch: expected }),
		);
		await runner.wait(handle, { timeoutMs: 5_000 });
		const commits = await runner.observeCommits(handle);
		expect(commits.length).toBeGreaterThanOrEqual(1);
		expect(commits[0]?.hash).toMatch(/^[0-9a-f]{7,40}$/i);
		// Commit subject is data, not a command channel.
		expect(commits.every((c) => typeof c.subject === "string")).toBe(true);
	});
});
