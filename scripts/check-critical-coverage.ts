/**
 * Critical-module coverage gate (requirement 47).
 *
 * Run: bun run coverage:critical
 *      bun run scripts/check-critical-coverage.ts
 *
 * Enforces ≥90% measured branch-path coverage independently for every named
 * critical module. Source is instrumented with Istanbul before Bun executes
 * the required suites; line coverage is never substituted for branch data.
 *
 * The command:
 *   - requires a reachable PostgreSQL fixture (DATABASE_URL)
 *   - runs the critical package suites under coverage
 *   - fails when any suite fails, any critical test is skipped, coverage is
 *     missing for a listed module, or a module is below threshold
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const THRESHOLD = 90;

export interface ModuleInfo {
	name: string;
	/** Regex matched against coverage table file paths. */
	pathPattern: RegExp;
	category:
		| "domain"
		| "queue"
		| "path-security"
		| "process-control"
		| "git-adapter"
		| "github-adapter"
		| "autopilot-adapter";
}

/** Central manifest of critical modules. Keep in sync with Phase 1 quality gates. */
export const CRITICAL_MODULES: ModuleInfo[] = [
	// Domain
	{
		name: "domain/feature-state-machine",
		pathPattern: /feature\/feature-state-machine\.ts$/,
		category: "domain",
	},
	{
		name: "domain/feature-service",
		pathPattern: /feature\/feature-service\.ts$/,
		category: "domain",
	},
	{
		name: "domain/release-service",
		pathPattern: /release\/release-service\.ts$/,
		category: "domain",
	},
	{
		name: "domain/project-service",
		pathPattern: /project\/project-service\.ts$/,
		category: "domain",
	},
	{
		name: "domain/task-approval-service",
		pathPattern: /task\/task-approval-service\.ts$/,
		category: "domain",
	},
	{
		name: "domain/attention-policy",
		pathPattern: /attention\/attention-policy\.ts$/,
		category: "domain",
	},
	{
		name: "domain/failure-policy",
		pathPattern: /failure\/failure-policy\.ts$/,
		category: "domain",
	},
	{
		name: "domain/development-progress",
		pathPattern: /release\/development-progress\.ts$/,
		category: "domain",
	},
	// Queue
	{
		name: "queue/development-queue",
		pathPattern: /queue\/development-queue\.ts$/,
		category: "queue",
	},
	{
		name: "queue/lease-reconciler",
		pathPattern: /queue\/lease-reconciler\.ts$/,
		category: "queue",
	},
	// Path-security
	{
		name: "path-security/workspace-path",
		pathPattern: /fs\/workspace-path\.ts$/,
		category: "path-security",
	},
	{
		name: "path-security/task-path",
		pathPattern: /fs\/task-path\.ts$/,
		category: "path-security",
	},
	// Process-control
	{
		name: "process-control/cancellation-controller",
		pathPattern: /process\/cancellation-controller\.ts$/,
		category: "process-control",
	},
	{
		name: "process-control/retry-service",
		pathPattern: /process\/retry-service\.ts$/,
		category: "process-control",
	},
	{
		name: "process-control/process-tree",
		pathPattern: /process\/process-tree\.ts$/,
		category: "process-control",
	},
	{
		name: "process-control/orphan-reconciler",
		pathPattern: /process\/orphan-reconciler\.ts$/,
		category: "process-control",
	},
	// Adapters (Git / GitHub / Autopilot)
	{
		name: "adapters/cli-git-gateway",
		pathPattern: /cli-git-gateway\.ts$/,
		category: "git-adapter",
	},
	{
		name: "adapters/gh-cli-gateway",
		pathPattern: /gh-cli-gateway\.ts$/,
		category: "github-adapter",
	},
	{
		name: "adapters/cli-autopilot-runner",
		pathPattern: /runner\/cli-autopilot-runner\.ts$/,
		category: "autopilot-adapter",
	},
];

export const CRITICAL_TEST_DIRS = [
	"packages/domain/src",
	"packages/database/src",
	"packages/shared/src",
	"packages/autopilot/src",
	"packages/git/src",
	"packages/github/src",
	"apps/worker/src",
] as const;

export const DEFAULT_DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console";

export interface ModuleCoverageResult {
	module: string;
	category: ModuleInfo["category"];
	filePath: string | null;
	coverage: number | null;
	pass: boolean;
	reason?: string;
}

const BRANCH_COVERAGE_START = "---PHASE1_BRANCH_COVERAGE_JSON---";
const BRANCH_COVERAGE_END = "---END_PHASE1_BRANCH_COVERAGE_JSON---";

interface IstanbulFileCoverage {
	b?: Record<string, number[]>;
}

/** Parse per-file executed branch paths from Istanbul coverage JSON. */
export function parseIstanbulBranchCoverage(output: string): Map<string, number> {
	const start = output.indexOf(BRANCH_COVERAGE_START);
	const end = output.indexOf(BRANCH_COVERAGE_END);
	const body =
		start >= 0 && end > start
			? output.slice(start + BRANCH_COVERAGE_START.length, end).trim()
			: output.trim();
	let decoded: Record<string, IstanbulFileCoverage>;
	try {
		decoded = JSON.parse(body) as Record<string, IstanbulFileCoverage>;
	} catch {
		throw new Error(
			"Measured branch coverage JSON is missing or malformed; line coverage is insufficient.",
		);
	}
	const coverage = new Map<string, number>();
	for (const [filePath, file] of Object.entries(decoded)) {
		if (!file.b || typeof file.b !== "object") continue;
		const paths = Object.values(file.b).flat();
		if (paths.length === 0) {
			// Istanbul convention: an instrumented module with no branch sites has
			// no uncovered branches, so its branch percentage is 100%.
			coverage.set(filePath, 100);
			continue;
		}
		const covered = paths.filter((count) => Number(count) > 0).length;
		coverage.set(filePath, (covered / paths.length) * 100);
	}
	if (coverage.size === 0) {
		throw new Error(
			"Measured branch coverage contains no branch paths; line coverage is insufficient.",
		);
	}
	return coverage;
}

/**
 * Parse Bun's text coverage table.
 *
 * Columns: File | % Funcs | % Lines | Uncovered Line #s
 * We record the line percentage for each source file path.
 */
export function parseBunTextCoverage(output: string): Map<string, number> {
	const coverage = new Map<string, number>();
	for (const line of output.split("\n")) {
		// Skip aggregate and non-file rows
		const match = line.match(/^\s*(.+?\.(?:ts|tsx|js|jsx))\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s*\|/);
		if (!match) continue;
		const filePath = match[1].trim();
		const linePct = Number.parseFloat(match[3]);
		if (!Number.isNaN(linePct)) {
			coverage.set(filePath, linePct);
		}
	}
	return coverage;
}

/** Extract skipped critical-suite tests from Bun reporter output. */
export function parseSkippedTests(output: string): string[] {
	const skipped: string[] = [];
	// Bun prints: (skip) name   or   skip  name
	for (const line of output.split("\n")) {
		const m =
			line.match(/^\s*\(skip\)\s+(.+?)\s*$/) ||
			line.match(/^\s*↓\s+(.+?)\s*$/) ||
			line.match(/^\s*skip\s+(.+?)\s*$/i);
		if (m?.[1]) skipped.push(m[1].trim());
	}
	// Summary line: "N skip" with N > 0 is also treated as evidence when details missing
	return skipped;
}

export function hasSkippedSummary(output: string): boolean {
	// e.g. "3 skip" in final summary
	return /(?:^|\s)([1-9]\d*)\s+skip(?:s|ped)?(?:\s|$)/im.test(output);
}

export function evaluateModuleCoverage(
	modules: ModuleInfo[],
	coverage: Map<string, number>,
	threshold = THRESHOLD,
): ModuleCoverageResult[] {
	return modules.map((mod) => {
		let foundPath: string | null = null;
		let branchPct: number | null = null;
		for (const [filePath, pct] of coverage) {
			if (mod.pathPattern.test(filePath)) {
				foundPath = filePath;
				branchPct = pct;
				break;
			}
		}
		if (foundPath === null || branchPct === null) {
			return {
				module: mod.name,
				category: mod.category,
				filePath: null,
				coverage: null,
				pass: false,
				reason: "coverage row not found for module",
			};
		}
		const pass = branchPct >= threshold;
		return {
			module: mod.name,
			category: mod.category,
			filePath: foundPath,
			coverage: branchPct,
			pass,
			reason: pass ? undefined : `below ${threshold}% threshold`,
		};
	});
}

export async function assertPostgresFixture(
	databaseUrl = DEFAULT_DATABASE_URL,
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		const postgres = (await import("postgres")).default;
		const sql = postgres(databaseUrl, { max: 1, idle_timeout: 2, connect_timeout: 5 });
		try {
			await sql`SELECT 1`;
			return { ok: true };
		} finally {
			await sql.end({ timeout: 2 });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			message:
				`PostgreSQL fixture unavailable at DATABASE_URL (${databaseUrl}): ${message}. ` +
				`Provision a reachable database before running coverage:critical ` +
				`(default postgres://postgres:postgres@127.0.0.1:5432/autopilot_console).`,
		};
	}
}

export interface GateOptions {
	/** Override spawn for tests. */
	runCoverage?: () => Promise<{ exitCode: number; output: string }>;
	databaseUrl?: string;
	threshold?: number;
	modules?: ModuleInfo[];
	/** When true, skip spawning tests (unit-test helpers only). */
	dryRunCoverageOutput?: string;
	dryRunExitCode?: number;
	skipFixtureCheck?: boolean;
}

export interface GateResult {
	ok: boolean;
	exitCode: number;
	results: ModuleCoverageResult[];
	messages: string[];
}

export async function runCriticalCoverageGate(options: GateOptions = {}): Promise<GateResult> {
	const messages: string[] = [];
	const modules = options.modules ?? CRITICAL_MODULES;
	const threshold = options.threshold ?? THRESHOLD;
	const databaseUrl = options.databaseUrl ?? DEFAULT_DATABASE_URL;

	if (!options.skipFixtureCheck) {
		const fixture = await assertPostgresFixture(databaseUrl);
		if (!fixture.ok) {
			messages.push(fixture.message);
			return { ok: false, exitCode: 1, results: [], messages };
		}
	}

	let exitCode: number;
	let output: string;
	if (options.dryRunCoverageOutput !== undefined) {
		exitCode = options.dryRunExitCode ?? 0;
		output = options.dryRunCoverageOutput;
	} else if (options.runCoverage) {
		const ran = await options.runCoverage();
		exitCode = ran.exitCode;
		output = ran.output;
	} else {
		const ran = await runDefaultCoverage(databaseUrl);
		exitCode = ran.exitCode;
		output = ran.output;
	}

	if (exitCode !== 0) {
		messages.push(
			`Critical test suite exited with code ${exitCode}. Coverage is not accepted when required suites fail.`,
		);
	}

	const skipped = parseSkippedTests(output);
	if (skipped.length > 0 || (hasSkippedSummary(output) && skipped.length === 0)) {
		messages.push(
			"Skipped critical tests detected — no skipped or conditionally disabled critical test may contribute to a passing coverage gate.",
		);
		if (skipped.length > 0) {
			for (const name of skipped.slice(0, 20)) {
				messages.push(`  skipped: ${name}`);
			}
		}
	}

	let coverage: Map<string, number>;
	try {
		coverage = parseIstanbulBranchCoverage(output);
	} catch (error) {
		messages.push(
			error instanceof Error
				? error.message
				: "Measured branch coverage is unavailable; line coverage cannot satisfy this gate.",
		);
		return { ok: false, exitCode: 1, results: [], messages };
	}

	const results = evaluateModuleCoverage(modules, coverage, threshold);
	const failed = results.filter((r) => !r.pass);
	for (const f of failed) {
		messages.push(
			`Module ${f.module}: ${f.coverage === null ? "not found" : `${f.coverage.toFixed(2)}%`} (${f.reason})`,
		);
	}

	// If suite failed or skips present, messages already set even when modules pass.
	const finalOk =
		exitCode === 0 &&
		failed.length === 0 &&
		!messages.some((m) => m.includes("Skipped") || m.includes("exited with code"));

	return {
		ok: finalOk,
		exitCode: finalOk ? 0 : 1,
		results,
		messages,
	};
}

async function runDefaultCoverage(
	databaseUrl: string,
): Promise<{ exitCode: number; output: string }> {
	const coverageFile = join(import.meta.dir, "..", "coverage", "critical-branch-coverage.json");
	rmSync(coverageFile, { force: true });
	const cmd = [
		"bun",
		"test",
		"--preload",
		"./scripts/branch-coverage-preload.ts",
		...CRITICAL_TEST_DIRS,
	];
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			DATABASE_URL: databaseUrl,
			PHASE1_BRANCH_COVERAGE_FILE: coverageFile,
		},
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	const branchCoverage =
		Bun.file(coverageFile).size > 0 ? readFileSync(coverageFile, "utf8") : "{}";
	return {
		exitCode,
		output: `${stdout}\n${stderr}\n${BRANCH_COVERAGE_START}\n${branchCoverage}\n${BRANCH_COVERAGE_END}`,
	};
}

function printReport(result: GateResult, threshold: number): void {
	console.log(`\nCritical Module Coverage Gate (threshold: ${threshold}% branch coverage)\n`);
	console.log("Module".padEnd(48), "Category".padEnd(18), "Coverage".padEnd(12), "Status");
	console.log("-".repeat(90));
	for (const r of result.results) {
		const status = r.pass ? "✓ PASS" : "✗ FAIL";
		const cov = r.coverage === null ? "not found" : `${r.coverage.toFixed(2)}%`;
		console.log(r.module.padEnd(48), r.category.padEnd(18), cov.padEnd(12), status);
	}
	console.log("-".repeat(90));
	if (result.messages.length > 0) {
		console.error("\nGate failures:");
		for (const m of result.messages) {
			console.error(`  - ${m}`);
		}
	}
	if (result.ok) {
		console.log(
			`\nAll ${result.results.length} critical modules meet ${threshold}% coverage with no skipped/failed required suites. ✓`,
		);
	}
}

async function main(): Promise<void> {
	const result = await runCriticalCoverageGate();
	printReport(result, THRESHOLD);
	process.exit(result.exitCode);
}

const isMain = typeof Bun !== "undefined" && Bun.main && import.meta.path === Bun.main;

if (isMain) {
	main().catch((err) => {
		console.error(err);
		process.exit(2);
	});
}
