/**
 * Self-tests for the critical coverage gate (requirement 47 RED/GREEN).
 *
 * Proves absent coverage, skipped tests, failing suites, and unavailable
 * PostgreSQL fixtures all fail the command — package aggregates cannot pass.
 */

import { describe, expect, test } from "bun:test";
import {
	CRITICAL_MODULES,
	evaluateModuleCoverage,
	hasSkippedSummary,
	parseBunTextCoverage,
	parseIstanbulBranchCoverage,
	parseSkippedTests,
	runCriticalCoverageGate,
} from "./check-critical-coverage";

const SAMPLE_TABLE = `
-----------------------------------------------------------|---------|---------|-------------------
File                                                       | % Funcs | % Lines | Uncovered Line #s
-----------------------------------------------------------|---------|---------|-------------------
All files                                                  |   89.46 |   90.29 |
 packages/domain/src/feature/feature-state-machine.ts      |  100.00 |  100.00 |
 packages/domain/src/feature/feature-service.ts            |  100.00 |   93.68 |
 packages/domain/src/release/release-service.ts            |   96.55 |   94.81 |
 packages/domain/src/project/project-service.ts            |   95.35 |   90.18 |
 packages/domain/src/task/task-approval-service.ts         |   96.43 |   84.25 |
 packages/domain/src/attention/attention-policy.ts         |  100.00 |  100.00 |
 packages/domain/src/failure/failure-policy.ts             |  100.00 |  100.00 |
 packages/domain/src/release/development-progress.ts       |  100.00 |  100.00 |
 packages/database/src/queue/development-queue.ts          |   85.71 |   96.88 |
 packages/database/src/queue/lease-reconciler.ts           |   75.00 |  100.00 |
 packages/shared/src/fs/workspace-path.ts                  |  100.00 |   93.55 |
 packages/shared/src/fs/task-path.ts                       |  100.00 |   95.06 |
 apps/worker/src/process/cancellation-controller.ts        |   92.31 |   95.22 |
 apps/worker/src/process/retry-service.ts                  |  100.00 |   94.90 |
 apps/worker/src/process/process-tree.ts                   |  100.00 |   93.69 |
 apps/worker/src/process/orphan-reconciler.ts              |   75.00 |   96.05 |
 packages/git/src/cli-git-gateway.ts                       |   80.00 |  100.00 |
 packages/github/src/gh-cli-gateway.ts                     |   92.31 |   89.93 |
 packages/autopilot/src/runner/cli-autopilot-runner.ts     |   89.13 |   99.11 |
-----------------------------------------------------------|---------|---------|-------------------

 430 pass
 0 fail
 0 skip
`;

function branchCoverageOutput(lowModules: string[] = []): string {
	const files = Object.fromEntries(
		[...parseBunTextCoverage(SAMPLE_TABLE).keys()].map((filePath) => [
			filePath,
			{
				branchMap: { 0: { type: "if", locations: [{}, {}] } },
				b: { 0: lowModules.includes(filePath) ? [1, 0] : [1, 1] },
			},
		]),
	);
	return `---PHASE1_BRANCH_COVERAGE_JSON---\n${JSON.stringify(files)}\n---END_PHASE1_BRANCH_COVERAGE_JSON---`;
}

describe("critical module manifest", () => {
	test("lists domain, queue, path-security, process-control, and adapter modules explicitly", () => {
		const categories = new Set(CRITICAL_MODULES.map((m) => m.category));
		for (const required of [
			"domain",
			"queue",
			"path-security",
			"process-control",
			"git-adapter",
			"github-adapter",
			"autopilot-adapter",
		] as const) {
			expect(categories.has(required)).toBe(true);
		}
		expect(CRITICAL_MODULES.length).toBeGreaterThanOrEqual(15);
		// Every entry has a unique name
		const names = CRITICAL_MODULES.map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("parseBunTextCoverage", () => {
	test("reads per-file line percentages and ignores the aggregate row", () => {
		const coverage = parseBunTextCoverage(SAMPLE_TABLE);
		expect(coverage.get("packages/domain/src/task/task-approval-service.ts")).toBe(84.25);
		expect(coverage.get("packages/github/src/gh-cli-gateway.ts")).toBe(89.93);
		expect(coverage.has("All files")).toBe(false);
	});
});

describe("parseIstanbulBranchCoverage", () => {
	test("uses executed branch paths and rejects line-only coverage", () => {
		const coverage = parseIstanbulBranchCoverage(
			JSON.stringify({
				"/repo/packages/domain/src/feature/feature-state-machine.ts": {
					branchMap: {
						0: { type: "if", locations: [{}, {}] },
						1: { type: "cond-expr", locations: [{}, {}] },
					},
					b: { 0: [3, 2], 1: [1, 0] },
				},
				"/repo/packages/git/src/cli-git-gateway.ts": {
					branchMap: {},
					b: {},
				},
			}),
		);
		expect(coverage.get("/repo/packages/domain/src/feature/feature-state-machine.ts")).toBe(75);
		expect(coverage.get("/repo/packages/git/src/cli-git-gateway.ts")).toBe(100);
		expect(() => parseIstanbulBranchCoverage(SAMPLE_TABLE)).toThrow(/branch coverage/i);
	});
});

describe("evaluateModuleCoverage", () => {
	test("fails an individual low module even when package aggregate would pass", () => {
		const coverage = parseBunTextCoverage(SAMPLE_TABLE);
		const results = evaluateModuleCoverage(CRITICAL_MODULES, coverage, 90);
		const byName = Object.fromEntries(results.map((r) => [r.module, r]));

		expect(byName["domain/task-approval-service"]?.pass).toBe(false);
		expect(byName["adapters/gh-cli-gateway"]?.pass).toBe(false);
		expect(byName["domain/feature-state-machine"]?.pass).toBe(true);
		expect(byName["queue/development-queue"]?.pass).toBe(true);

		// Aggregate cannot rescue a missing module
		const missingCoverage = new Map(coverage);
		missingCoverage.delete("packages/domain/src/task/task-approval-service.ts");
		const missingResults = evaluateModuleCoverage(CRITICAL_MODULES, missingCoverage, 90);
		const missing = missingResults.find((r) => r.module === "domain/task-approval-service");
		expect(missing?.pass).toBe(false);
		expect(missing?.reason).toMatch(/not found/i);
	});
});

describe("skip detection", () => {
	test("parseSkippedTests and hasSkippedSummary detect skipped critical tests", () => {
		const output = `
(skip) installed autopilotagent CLI contract
(skip) optional long-running process fixture
 122 pass
 2 skip
 0 fail
`;
		expect(parseSkippedTests(output)).toEqual([
			"installed autopilotagent CLI contract",
			"optional long-running process fixture",
		]);
		expect(hasSkippedSummary(output)).toBe(true);
		expect(hasSkippedSummary("0 skip\n")).toBe(false);
	});
});

describe("runCriticalCoverageGate failure modes", () => {
	test("absent coverage data fails the gate", async () => {
		const result = await runCriticalCoverageGate({
			skipFixtureCheck: true,
			dryRunExitCode: 0,
			dryRunCoverageOutput: "no coverage table here\n 10 pass\n 0 fail\n 0 skip\n",
		});
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.messages.some((m) => /branch coverage/i.test(m))).toBe(true);
	});

	test("skipped critical tests fail the gate even when modules meet threshold", async () => {
		const result = await runCriticalCoverageGate({
			skipFixtureCheck: true,
			dryRunExitCode: 0,
			dryRunCoverageOutput: `${branchCoverageOutput()}\n(skip) critical process fixture\n 1 skip\n`,
		});
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => /Skipped critical tests/i.test(m))).toBe(true);
	});

	test("non-zero suite exit fails the gate", async () => {
		const result = await runCriticalCoverageGate({
			skipFixtureCheck: true,
			dryRunExitCode: 1,
			dryRunCoverageOutput: `${branchCoverageOutput()}\n 1 fail\n`,
		});
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => /exited with code 1/i.test(m))).toBe(true);
	});

	test("unavailable PostgreSQL fixture fails without running suites", async () => {
		const result = await runCriticalCoverageGate({
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/does-not-exist",
			runCoverage: async () => {
				throw new Error("should not run coverage when fixture is down");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => /PostgreSQL fixture unavailable/i.test(m))).toBe(true);
	});

	test("all modules above threshold with clean suite pass", async () => {
		const result = await runCriticalCoverageGate({
			skipFixtureCheck: true,
			dryRunExitCode: 0,
			dryRunCoverageOutput: `${branchCoverageOutput()}\n 0 skip\n 0 fail\n`,
		});
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.results.every((r) => r.pass)).toBe(true);
	});
});
