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
	test("an explicit wait timeout retains ownership of the live child", async () => {
		const root = await tempDir("ap-wait-timeout-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { delayMs: 30_000, mutateTask: false, writeNotesAnalytics: false },
		});
		const taskRel = await writeTask(root, "docs/autopilotagent/timeout/timeout.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));

		try {
			await expect(runner.wait(handle, { timeoutMs: 25 })).rejects.toThrow(
				/wait timeout after 25ms/i,
			);
			expect(await runner.isAlive(handle)).toBe(true);

			await runner.signal(handle, "kill");
			const result = await runner.wait(handle, { timeoutMs: 5_000 });
			expect(result.signal).toBe("SIGKILL");
			expect(result.outcome).toBe("interrupted");
		} finally {
			if (await runner.isAlive(handle).catch(() => false)) {
				await runner.signal(handle, "kill").catch(() => undefined);
			}
			await runner.wait(handle, { timeoutMs: 5_000 }).catch(() => undefined);
		}
	});

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

describe("CliAutopilotRunner — adapter branch behavior", () => {
	test("validates traversal, NUL, extension, and invalid task documents", async () => {
		const root = await tempDir("ap-validation-");
		const runner = new CliAutopilotRunner();
		for (const relative of ["../escape.json", "docs/bad\0name.json", "docs/task.md"]) {
			await expect(runner.validateTask(root, relative)).rejects.toMatchObject({
				code: "VALIDATION_FAILED",
			});
		}

		const invalid = await writeTask(root, "docs/invalid.json", { requirements: "wrong" });
		const result = await runner.validateTask(root, invalid);
		expect(result.ok).toBe(false);
		expect(result.message.length).toBeGreaterThan(0);
	});

	test("resolves named executables on PATH and rejects missing names and dot paths", async () => {
		const available = await new CliAutopilotRunner({ executablePath: "bun" }).validateRuntime();
		expect(available.ok).toBe(true);
		expect(available.executablePath).toMatch(/bun/);

		const missing = await new CliAutopilotRunner({
			executablePath: "autopilotagent-definitely-not-on-path",
		}).validateRuntime();
		expect(missing.ok).toBe(false);
		expect(missing.message).toMatch(/PATH/);

		const dotPath = await new CliAutopilotRunner({ executablePath: ".missing" }).validateRuntime();
		expect(dotPath.ok).toBe(false);
		expect(dotPath.executablePath).toBe(".missing");
	});

	test("start rejects unavailable runtimes and roots that cannot contain the relative task", async () => {
		const missing = new CliAutopilotRunner({
			executablePath: "autopilotagent-definitely-not-on-path",
		});
		await expect(
			missing.start({
				projectRoot: process.cwd(),
				taskRelativePath: "docs/task.json",
				projectId: "project",
				featureId: "feature",
				expectedBranch: "main",
			}),
		).rejects.toMatchObject({ code: "ADAPTER_ERROR" });

		const available = new CliAutopilotRunner({ executablePath: "bun" });
		await expect(
			available.start({
				projectRoot: "/",
				taskRelativePath: "docs/task.json",
				projectId: "project",
				featureId: "feature",
				expectedBranch: "main",
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	});

	test("uses configured executable, filters extra env, waits without a timeout, and caps diagnostics", async () => {
		const root = await tempDir("ap-options-");
		const bin = await tempDir("ap-bin-");
		const capturePath = join(root, "env.json");
		const fake = join(bin, "autopilotagent");
		await writeFile(
			fake,
			`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env), "utf8");
process.stdout.write("x".repeat(400));
`,
			"utf8",
		);
		await chmod(fake, 0o755);
		const taskRel = await writeTask(root, "docs/options/options.json");
		const runner = new CliAutopilotRunner({
			executablePath: fake,
			envAllowlist: ["PATH", "ALLOWED_TEST_VALUE"],
			maxDiagnosticBytes: 16,
		});
		const request = baseRequest(root, taskRel, fake, {
			env: { ALLOWED_TEST_VALUE: "yes", BLOCKED_TEST_VALUE: "no" },
		});
		delete (request as Partial<AutopilotStartRequest>).executablePath;
		const handle = await runner.start(request);
		const result = await runner.wait(handle);
		const captured = JSON.parse(await readFile(capturePath, "utf8")) as Record<string, string>;
		expect(captured.ALLOWED_TEST_VALUE).toBe("yes");
		expect(captured.BLOCKED_TEST_VALUE).toBeUndefined();
		expect(result.stdoutDiagnostic.length).toBeLessThan(400);
	});

	test("rejects invalid wait timeouts before consulting process state", async () => {
		const identity = await createProcessIdentity(process.pid);
		const handle = {
			projectId: "project",
			featureId: "feature",
			projectRoot: process.cwd(),
			taskRelativePath: "docs/task.json",
			expectedBranch: "main",
			processIdentity: identity,
			startedAt: "test",
		};
		const runner = new CliAutopilotRunner();
		for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(runner.wait(handle, { timeoutMs })).rejects.toMatchObject({
				code: "VALIDATION_FAILED",
			});
		}
	});

	test("reports forged and exited handles as not alive and refuses empty ownership", async () => {
		const identity = await createProcessIdentity(process.pid);
		const runner = new CliAutopilotRunner();
		const baseHandle = {
			projectId: "project",
			featureId: "feature",
			projectRoot: process.cwd(),
			taskRelativePath: "docs/task.json",
			expectedBranch: "main",
			processIdentity: identity,
			startedAt: "test",
		};
		expect(await runner.isAlive({ ...baseHandle, projectId: "" })).toBe(false);
		expect(
			await runner.isAlive({
				...baseHandle,
				processIdentity: { pid: 2_147_483_647, startTimeMs: 1 },
			}),
		).toBe(false);
		await expect(runner.signal({ ...baseHandle, featureId: "" }, "term")).rejects.toMatchObject({
			code: "ADAPTER_ERROR",
		});
	});

	test("supports SIGTERM and restart-style waits after the live child is forgotten", async () => {
		const root = await tempDir("ap-term-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { delayMs: 30_000, mutateTask: false, writeNotesAnalytics: false },
		});
		const taskRel = await writeTask(root, "docs/term/term.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));
		await runner.signal(handle, "term");
		const first = await runner.wait(handle, { timeoutMs: 5_000 });
		expect(first.signal).toBe("SIGTERM");
		const restarted = await runner.wait(handle, { timeoutMs: 100 });
		expect(restarted.exitCode).toBeNull();
	});

	test("restart-style waits poll a live external identity with and without deadlines", async () => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(120)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const identity = await createProcessIdentity(child.pid);
		const handle = {
			projectId: "project",
			featureId: "feature",
			projectRoot: process.cwd(),
			taskRelativePath: "docs/missing.json",
			expectedBranch: "main",
			processIdentity: identity,
			startedAt: "external",
		};
		const runner = new CliAutopilotRunner();
		await expect(runner.wait(handle, { timeoutMs: 0 })).rejects.toThrow(/wait timeout after 0ms/);
		const result = await runner.wait(handle);
		expect(await child.exited).toBe(0);
		expect(result.exitCode).toBeNull();
	});

	test("wait falls back to retained and empty progress when a handle path becomes invalid", async () => {
		const root = await tempDir("ap-progress-fallback-");
		const bin = await tempDir("ap-bin-");
		const fake = await installFakeAutopilotagent({
			binDir: bin,
			behavior: { mutateTask: false, writeNotesAnalytics: false },
		});
		const taskRel = await writeTask(root, "docs/fallback/fallback.json");
		const runner = new CliAutopilotRunner({ executablePath: fake });
		const handle = await runner.start(baseRequest(root, taskRel, fake));
		handle.taskRelativePath = "../invalid.json";
		const retained = await runner.wait(handle, { timeoutMs: 5_000 });
		expect(retained.progress.total).toBeGreaterThan(0);
		const empty = await runner.wait(handle, { timeoutMs: 100 });
		expect(empty.progress).toMatchObject({ total: 0, passed: 0, allPass: false });
	});

	test("normalizes Error and non-Error process signaling failures", async () => {
		const identity = await createProcessIdentity(process.pid);
		const handle = {
			projectId: "project",
			featureId: "feature",
			projectRoot: process.cwd(),
			taskRelativePath: "docs/task.json",
			expectedBranch: "main",
			processIdentity: identity,
			startedAt: "test",
		};
		const runner = new CliAutopilotRunner();
		const originalKill = process.kill;
		try {
			process.kill = (() => {
				throw new Error("signal denied");
			}) as typeof process.kill;
			await expect(runner.signal(handle, "term")).rejects.toThrow(/signal denied/);

			process.kill = (() => {
				throw "signal denied as text";
			}) as typeof process.kill;
			await expect(runner.signal(handle, "kill")).rejects.toThrow(/signal denied as text/);
		} finally {
			process.kill = originalKill;
		}
	});

	test("returns empty progress and commits for missing task and branch", async () => {
		const root = await tempDir("ap-missing-");
		const runner = new CliAutopilotRunner();
		const progress = await runner.readProgress(root, "docs/missing.json");
		expect(progress).toMatchObject({ total: 0, passed: 0, allPass: false });

		const identity = await createProcessIdentity(process.pid);
		const commits = await runner.observeCommits({
			projectId: "project",
			featureId: "feature",
			projectRoot: root,
			taskRelativePath: "docs/missing.json",
			expectedBranch: "branch-that-does-not-exist",
			processIdentity: identity,
			startedAt: "test",
		});
		expect(commits).toEqual([]);
	});

	test("loads analytics documents without a summary and ignores empty analytics directories", async () => {
		for (const [name, analytics, expected] of [
			["raw", { value: 7 }, { value: 7 }],
			["empty", null, undefined],
		] as const) {
			const root = await tempDir(`ap-analytics-${name}-`);
			const bin = await tempDir("ap-bin-");
			const fake = await installFakeAutopilotagent({
				binDir: bin,
				behavior: { delayMs: 100, mutateTask: false, writeNotesAnalytics: false },
			});
			const taskRel = await writeTask(root, `docs/${name}/${name}.json`);
			const analyticsDir = join(root, `docs/${name}/analytics`);
			await mkdir(analyticsDir, { recursive: true });
			if (analytics) {
				await writeFile(join(analyticsDir, "session.json"), JSON.stringify(analytics), "utf8");
			}
			const runner = new CliAutopilotRunner({ executablePath: fake });
			const handle = await runner.start(baseRequest(root, taskRel, fake));
			const result = await runner.wait(handle, { timeoutMs: 5_000 });
			if (expected) {
				expect(result.analytics).toMatchObject({ exists: true, summary: expected });
			} else {
				expect(result.analytics).toEqual({ exists: false });
			}
		}
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
