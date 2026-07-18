/**
 * Controllable fake autopilotagent executable for adapter integration tests.
 * Writes a small Node/Bun script that mimics run.sh sibling artifacts.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeAutopilotagentOptions {
	/** Directory that will contain the fake binary. */
	binDir: string;
	/** Behavior script body fragments. */
	behavior?: FakeBehavior;
}

export interface FakeBehavior {
	/** Exit code after work (default 0). */
	exitCode?: number;
	/** Write sibling run.pid with own PID (default true). */
	writePid?: boolean;
	/** Mutate task JSON passes flags (default true for first req). */
	mutateTask?: boolean;
	/** Write notes and analytics siblings (default true). */
	writeNotesAnalytics?: boolean;
	/** Hold open until SIGUSR1 then exit 0 (default false). */
	waitForSigusr1?: boolean;
	/** Attempt git checkout of task basename (default false). */
	checkoutBasename?: boolean;
	/** Emit credential-bearing stdout for redaction tests. */
	emitSecrets?: boolean;
	/** Sleep milliseconds before exit (default 0). */
	delayMs?: number;
	/** Write partial/malformed task JSON mid-run. */
	writeMalformedTask?: boolean;
	/** Custom stdout text. */
	stdout?: string;
	/** Custom stderr text. */
	stderr?: string;
}

/**
 * Install a fake `autopilotagent` executable at binDir/autopilotagent.
 * Returns absolute path to the fake binary.
 */
export async function installFakeAutopilotagent(
	options: FakeAutopilotagentOptions,
): Promise<string> {
	const { binDir, behavior = {} } = options;
	await mkdir(binDir, { recursive: true });
	const scriptPath = join(binDir, "autopilotagent");
	const cfg = {
		exitCode: behavior.exitCode ?? 0,
		writePid: behavior.writePid !== false,
		mutateTask: behavior.mutateTask !== false,
		writeNotesAnalytics: behavior.writeNotesAnalytics !== false,
		waitForSigusr1: behavior.waitForSigusr1 === true,
		checkoutBasename: behavior.checkoutBasename === true,
		emitSecrets: behavior.emitSecrets === true,
		delayMs: behavior.delayMs ?? 0,
		writeMalformedTask: behavior.writeMalformedTask === true,
		stdout: behavior.stdout ?? "",
		stderr: behavior.stderr ?? "",
	};

	// Self-contained Bun/Node script; no shell wrapper.
	const body = `#!/usr/bin/env bun
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cfg = ${JSON.stringify(cfg)};
const taskArg = process.argv[2];
if (!taskArg) {
  console.error("usage: autopilotagent <task.json>");
  process.exit(2);
}

const cwd = process.cwd();
const taskPath = resolve(cwd, taskArg);
const featureDir = dirname(taskPath);
const pidPath = join(featureDir, "run.pid");
const base = basename(taskPath, ".json");

if (cfg.writePid) {
  writeFileSync(pidPath, String(process.pid), "utf8");
}

if (cfg.emitSecrets) {
  console.log("Authorization: Bearer ghp_SECRETTOKEN12345678901234567890");
  console.log("password=supersecret");
  console.error("GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUV");
}

if (cfg.stdout) process.stdout.write(cfg.stdout);
if (cfg.stderr) process.stderr.write(cfg.stderr);

if (cfg.checkoutBasename) {
  spawnSync("git", ["checkout", base], { cwd, stdio: "ignore" });
  spawnSync("git", ["checkout", "-b", base], { cwd, stdio: "ignore" });
}

if (cfg.writeNotesAnalytics) {
  const notes = join(featureDir, base + "-notes.md");
  const analyticsDir = join(featureDir, "analytics");
  mkdirSync(analyticsDir, { recursive: true });
  const analytics = join(analyticsDir, "session-1.json");
  writeFileSync(notes, "# notes\\npassword=should-not-leak-if-redacted\\n", "utf8");
  writeFileSync(
    analytics,
    JSON.stringify({
      sessionId: "fake-session",
      mode: "tasks",
      summary: { completed: 1, stuck: 0, invalidTest: 0 },
    }),
    "utf8",
  );
}

if (cfg.writeMalformedTask && existsSync(taskPath)) {
  writeFileSync(taskPath, "{ partial", "utf8");
} else if (cfg.mutateTask && existsSync(taskPath)) {
  try {
    const raw = readFileSync(taskPath, "utf8");
    const doc = JSON.parse(raw);
    if (Array.isArray(doc.requirements) && doc.requirements[0]) {
      doc.requirements[0].passes = true;
      if (doc.requirements[0].tdd) {
        doc.requirements[0].tdd.test = { ...(doc.requirements[0].tdd.test || {}), passes: true };
        doc.requirements[0].tdd.implement = {
          ...(doc.requirements[0].tdd.implement || {}),
          passes: true,
        };
        doc.requirements[0].tdd.refactor = {
          ...(doc.requirements[0].tdd.refactor || {}),
          passes: true,
        };
      }
    }
    writeFileSync(taskPath, JSON.stringify(doc, null, 2), "utf8");
  } catch {
    // leave file as-is
  }
}

function cleanup() {
  try {
    if (cfg.writePid && existsSync(pidPath)) {
      // mirror run.sh: remove pid on exit
      // (tests may race; ignore errors)
    }
  } catch {}
}

if (cfg.waitForSigusr1) {
  let stop = false;
  process.on("SIGUSR1", () => {
    stop = true;
  });
  process.on("SIGTERM", () => {
    process.exit(143);
  });
  const start = Date.now();
  while (!stop && Date.now() - start < 30_000) {
    await Bun.sleep(50);
  }
  cleanup();
  process.exit(cfg.exitCode);
}

if (cfg.delayMs > 0) {
  await Bun.sleep(cfg.delayMs);
}

cleanup();
process.exit(cfg.exitCode);
`;

	await writeFile(scriptPath, body, "utf8");
	await chmod(scriptPath, 0o755);
	return scriptPath;
}
