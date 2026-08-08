/**
 * Unit tests for the Phase 1 release-qualification command (requirement 48 RED/GREEN).
 *
 * Proves skip detection, fail-closed dependency handling, and gate orchestration
 * without re-running the full monorepo suite.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertDocumentationAlignment,
	assertQualificationScriptContract,
	detectSkippedTests,
	formatSummary,
	hasSkipSummary,
	PHASE1_GATES,
	runComposeStackQualification,
	runPhase1Qualification,
	type SpawnResult,
} from "./verify-phase-1";

const ROOT = join(import.meta.dir, "..");

describe("PHASE1_GATES manifest", () => {
	test("lists every required release gate in order", () => {
		expect([...PHASE1_GATES]).toEqual([
			"dependencies",
			"typecheck",
			"lint",
			"unit",
			"database",
			"process",
			"browser",
			"coverage",
			"build",
			"migrations",
			"image",
			"compose",
			"deployment-smoke",
		]);
	});
});

describe("skip detection", () => {
	test("detectSkippedTests and hasSkipSummary reject skipped critical tests", () => {
		const output = `
(skip) installed autopilotagent CLI contract
(skip) optional long-running process fixture
 122 pass
 2 skip
 0 fail
`;
		expect(detectSkippedTests(output)).toEqual([
			"installed autopilotagent CLI contract",
			"optional long-running process fixture",
		]);
		expect(hasSkipSummary(output)).toBe(true);
		expect(hasSkipSummary("0 skip\n")).toBe(false);
		expect(detectSkippedTests(" 10 pass\n 0 skip\n")).toEqual([]);
	});
});

describe("assertQualificationScriptContract", () => {
	test("passes for the repository root", () => {
		const result = assertQualificationScriptContract(ROOT);
		expect(result.ok).toBe(true);
		expect(result.scriptBody).toMatch(/verify-phase-1/);
	});

	test("fails when verify:phase-1 is absent", () => {
		const tmp = join(ROOT, "coverage", "req-48-contract-absent");
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
		const result = assertQualificationScriptContract(tmp);
		expect(result.ok).toBe(false);
		expect(result.messages.join("\n")).toMatch(/verify:phase-1/);
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("assertDocumentationAlignment", () => {
	test("passes for the live repository docs", () => {
		const result = assertDocumentationAlignment(ROOT);
		expect(result.ok).toBe(true);
	});

	test("fails when README omits the qualification command", () => {
		const tmp = join(ROOT, "coverage", "req-48-docs-missing");
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "docs/autopilotagent/autopilot-console-phase-1"), { recursive: true });
		writeFileSync(join(tmp, "README.md"), "# Project\n");
		writeFileSync(join(tmp, "docs/deployment.md"), "# Deploy\n");
		writeFileSync(join(tmp, "docs/operations.md"), "# Ops\n");
		writeFileSync(join(tmp, "CHANGELOG.md"), "# Changelog\n");
		writeFileSync(
			join(tmp, "docs/autopilotagent/autopilot-console-phase-1/autopilot-console-phase-1.json"),
			"{}",
		);
		const result = assertDocumentationAlignment(tmp);
		expect(result.ok).toBe(false);
		expect(result.messages.join("\n")).toMatch(/verify:phase-1|qualification/i);
		rmSync(tmp, { recursive: true, force: true });
	});
});

describe("runPhase1Qualification fail-closed behavior", () => {
	test("staticOnly succeeds when contracts are satisfied", async () => {
		const summary = await runPhase1Qualification({ staticOnly: true, root: ROOT });
		expect(summary.ok).toBe(true);
		expect(summary.gates).toHaveLength(PHASE1_GATES.length);
		expect(summary.command).toBe("bun run verify:phase-1");
	});

	test("fails closed when a spawned gate exits non-zero", async () => {
		const spawn = async (cmd: string[]): Promise<SpawnResult> => {
			const joined = cmd.join(" ");
			// Dependency probes
			if (joined.includes("command -v docker")) {
				return { exitCode: 0, stdout: "/usr/bin/docker\n", stderr: "" };
			}
			if (joined.includes("docker version")) {
				return { exitCode: 0, stdout: "29.0.0\n", stderr: "" };
			}
			if (joined.includes("select 1") || joined.includes("postgres")) {
				return { exitCode: 0, stdout: "postgres-ok\n", stderr: "" };
			}
			// First real suite gate fails
			if (joined.includes("typecheck")) {
				return {
					exitCode: 2,
					stdout: "",
					stderr: "error TS2304: Cannot find name 'x'\n",
				};
			}
			return { exitCode: 0, stdout: "ok\n", stderr: "" };
		};

		const summary = await runPhase1Qualification({
			root: ROOT,
			spawn,
			failFast: true,
			env: { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console" },
		});
		expect(summary.ok).toBe(false);
		const typecheck = summary.gates.find((g) => g.name === "typecheck");
		expect(typecheck?.ok).toBe(false);
		expect(typecheck?.message ?? "").toMatch(/typecheck|failed/i);
		// Fail-fast: later gates must not run
		expect(summary.gates.some((g) => g.name === "browser")).toBe(false);
	});

	test("fails closed when a gate reports skipped tests", async () => {
		const spawn = async (cmd: string[]): Promise<SpawnResult> => {
			const joined = cmd.join(" ");
			if (joined.includes("command -v docker")) {
				return { exitCode: 0, stdout: "/usr/bin/docker\n", stderr: "" };
			}
			if (joined.includes("docker version")) {
				return { exitCode: 0, stdout: "29.0.0\n", stderr: "" };
			}
			if (
				joined.includes("select 1") ||
				joined.includes("postgres-ok") ||
				joined.includes("postgres")
			) {
				return { exitCode: 0, stdout: "postgres-ok\n", stderr: "" };
			}
			if (joined.includes("bun run test") || joined.includes("bun test")) {
				return {
					exitCode: 0,
					stdout: "(skip) critical path fixture\n 1 pass\n 1 skip\n 0 fail\n",
					stderr: "",
				};
			}
			if (joined.includes("typecheck") || joined.includes("lint")) {
				return { exitCode: 0, stdout: "ok\n", stderr: "" };
			}
			return { exitCode: 0, stdout: "ok\n", stderr: "" };
		};

		const summary = await runPhase1Qualification({
			root: ROOT,
			spawn,
			failFast: true,
			env: { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console" },
		});
		expect(summary.ok).toBe(false);
		const failed = summary.gates.find((g) => !g.ok && g.name !== "dependencies");
		expect(failed).toBeDefined();
		expect(failed?.message ?? "").toMatch(/skip/i);
	});

	test("formatSummary reports PASS/FAIL and the documented command", () => {
		const text = formatSummary({
			ok: false,
			startedAt: "2026-07-31T00:00:00.000Z",
			finishedAt: "2026-07-31T00:01:00.000Z",
			durationMs: 60_000,
			command: "bun run verify:phase-1",
			dependencies: {
				bun: { ok: true, detail: "bun 1.3.14" },
			},
			gates: [
				{
					name: "typecheck",
					ok: false,
					durationMs: 100,
					exitCode: 1,
					message: "Gate typecheck failed",
				},
			],
		});
		expect(text).toMatch(/FAIL/);
		expect(text).toMatch(/bun run verify:phase-1/);
		expect(text).toMatch(/typecheck/);
		expect(text).toMatch(/fails closed|failed closed/i);
	});

	test("image gate fails closed when Docker daemon is unavailable", async () => {
		const printGraph = JSON.stringify({
			target: {
				api: { context: "." },
				web: { context: "." },
				worker: { context: "." },
				migrate: { context: "." },
			},
		});
		const spawn = async (cmd: string[]): Promise<SpawnResult> => {
			const joined = cmd.join(" ");
			if (joined.includes("command -v docker")) {
				return { exitCode: 0, stdout: "/usr/bin/docker\n", stderr: "" };
			}
			if (joined.includes("compose version")) {
				return { exitCode: 0, stdout: "Docker Compose version v5.3.1\n", stderr: "" };
			}
			if (joined.includes("select 1") || joined.includes("postgres")) {
				return { exitCode: 0, stdout: "postgres-ok\n", stderr: "" };
			}
			if (joined.includes("docker info")) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: "Cannot connect to the Docker daemon\n",
				};
			}
			if (joined.includes("--print")) {
				return { exitCode: 0, stdout: printGraph, stderr: "" };
			}
			if (joined.includes("--check")) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: "Cannot connect to the Docker daemon\n",
				};
			}
			if (joined.includes("compose config")) {
				return {
					exitCode: 0,
					stdout:
						"name: autopilot-console\nservices:\n  web:\n    image: x\n  api:\n    image: x\n  worker:\n    image: x\n  postgres:\n    image: x\n  migrate:\n    image: x\n",
					stderr: "",
				};
			}
			if (joined.includes("deployment-smoke") || joined.includes("createDatabaseClient")) {
				return { exitCode: 0, stdout: "deployment-smoke-ok tables=12\n", stderr: "" };
			}
			return { exitCode: 0, stdout: "ok\n 0 skip\n", stderr: "" };
		};

		const summary = await runPhase1Qualification({
			root: ROOT,
			spawn,
			failFast: true,
			env: { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console" },
		});
		const image = summary.gates.find((g) => g.name === "image");
		expect(image?.ok).toBe(false);
		expect(image?.message ?? "").toMatch(/Docker daemon.*unavailable|cannot connect/i);
		expect(summary.ok).toBe(false);
	});

	test("image gate fails closed when build graph omits a required target", async () => {
		const printGraph = JSON.stringify({
			target: {
				api: { context: "." },
				web: { context: "." },
			},
		});
		const spawn = async (cmd: string[]): Promise<SpawnResult> => {
			const joined = cmd.join(" ");
			if (joined.includes("command -v docker")) {
				return { exitCode: 0, stdout: "/usr/bin/docker\n", stderr: "" };
			}
			if (joined.includes("compose version")) {
				return { exitCode: 0, stdout: "Docker Compose version v5.3.1\n", stderr: "" };
			}
			if (joined.includes("select 1") || joined.includes("postgres")) {
				return { exitCode: 0, stdout: "postgres-ok\n", stderr: "" };
			}
			if (joined.includes("docker info")) {
				return { exitCode: 1, stdout: "", stderr: "daemon down\n" };
			}
			if (joined.includes("--print")) {
				return { exitCode: 0, stdout: printGraph, stderr: "" };
			}
			return { exitCode: 0, stdout: "ok\n 0 skip\n", stderr: "" };
		};

		const summary = await runPhase1Qualification({
			root: ROOT,
			spawn,
			failFast: true,
			env: { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console" },
		});
		expect(summary.ok).toBe(false);
		const image = summary.gates.find((g) => g.name === "image");
		expect(image?.ok).toBe(false);
		expect(image?.message ?? "").toMatch(/missing targets|worker|migrate/i);
	});
});

describe("runComposeStackQualification", () => {
	test("starts from empty volumes, verifies health and recovery, then cleans up", async () => {
		const calls: string[] = [];
		const spawn = async (cmd: string[]): Promise<SpawnResult> => {
			calls.push(cmd.join(" "));
			if (cmd.includes("ps")) {
				return {
					exitCode: 0,
					stdout: ["postgres", "migrate", "api", "worker", "web"]
						.map((service) => JSON.stringify({ Service: service, Health: "healthy", State: "running" }))
						.join("\n"),
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "phase1-compose-ok\n", stderr: "" };
		};

		const result = await runComposeStackQualification(spawn, ROOT, {
			COMPOSE_PROJECT_NAME: "phase1-test",
		});

		expect(result.compose.ok).toBe(true);
		expect(result.deployment.ok).toBe(true);
		expect(calls).toContain(
			"docker compose down --volumes --remove-orphans --timeout 10",
		);
		expect(calls).toContain("docker compose up -d --wait --wait-timeout 120");
		expect(calls.some((call) => call.includes("pg_dump") && call.includes("psql"))).toBe(true);
		expect(calls.at(-1)).toBe("docker compose down --volumes --remove-orphans --timeout 10");
	});

	test("fails both gates and still cleans up when the stack cannot become healthy", async () => {
		const calls: string[] = [];
		const spawn = async (cmd: string[]): Promise<SpawnResult> => {
			const call = cmd.join(" ");
			calls.push(call);
			if (call.includes(" compose up ")) {
				return { exitCode: 1, stdout: "", stderr: "worker unhealthy" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await runComposeStackQualification(spawn, ROOT, {
			COMPOSE_PROJECT_NAME: "phase1-test",
		});

		expect(result.compose.ok).toBe(false);
		expect(result.deployment.ok).toBe(false);
		expect(result.compose.message).toMatch(/worker unhealthy|healthy/i);
		expect(calls.at(-1)).toBe("docker compose down --volumes --remove-orphans --timeout 10");
	});
});
