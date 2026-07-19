/**
 * Check branch coverage for critical modules meets 90% threshold.
 *
 * Run: bun run scripts/check-critical-coverage.ts
 *
 * Runs `bun test --coverage` for critical packages, parses the text output
 * for branch coverage (Bun's lcov reporter does not emit branch data), and
 * verifies that each critical module meets the 90% branch coverage target.
 *
 * Critical modules per requirement 31 acceptance:
 *   domain, queue, path-security, process-control, adapters
 */

const THRESHOLD = 90;

interface ModuleInfo {
	name: string;
	pathPattern: RegExp;
}

const CRITICAL_MODULES: ModuleInfo[] = [
	// Domain
	{ name: "domain/feature-state-machine", pathPattern: /feature\/feature-state-machine\.ts$/ },
	{ name: "domain/feature-service", pathPattern: /feature\/feature-service\.ts$/ },
	{ name: "domain/release-service", pathPattern: /release\/release-service\.ts$/ },
	{ name: "domain/project-service", pathPattern: /project\/project-service\.ts$/ },
	{ name: "domain/task-approval-service", pathPattern: /task\/task-approval-service\.ts$/ },
	{ name: "domain/attention-policy", pathPattern: /attention\/attention-policy\.ts$/ },
	{ name: "domain/failure-policy", pathPattern: /failure\/failure-policy\.ts$/ },
	{ name: "domain/development-progress", pathPattern: /release\/development-progress\.ts$/ },
	// Queue
	{ name: "queue/development-queue", pathPattern: /queue\/development-queue\.ts$/ },
	{ name: "queue/lease-reconciler", pathPattern: /queue\/lease-reconciler\.ts$/ },
	// Path-security
	{ name: "path-security/workspace-path", pathPattern: /fs\/workspace-path\.ts$/ },
	{ name: "path-security/task-path", pathPattern: /fs\/task-path\.ts$/ },
	// Process-control
	{
		name: "process-control/cancellation-controller",
		pathPattern: /process\/cancellation-controller\.ts$/,
	},
	{ name: "process-control/retry-service", pathPattern: /process\/retry-service\.ts$/ },
	{ name: "process-control/process-tree", pathPattern: /process\/process-tree\.ts$/ },
	{ name: "process-control/orphan-reconciler", pathPattern: /process\/orphan-reconciler\.ts$/ },
	// Adapters
	{ name: "adapters/cli-autopilot-runner", pathPattern: /runner\/cli-autopilot-runner\.ts$/ },
	{ name: "adapters/cli-git-gateway", pathPattern: /cli-git-gateway\.ts$/ },
	{ name: "adapters/gh-cli-gateway", pathPattern: /gh-cli-gateway\.ts$/ },
];

/**
 * Parse Bun's text coverage output.
 *
 * Format example:
 *   packages/domain/src/feature/feature-state-machine.ts |  100.00 |   86.67 | 4-6,8-14,17-46
 *
 * Columns: File | Line% | Branch% | Funcs% | Uncovered Lines
 * (Funcs% column may be absent in older Bun versions; columns vary.)
 */
function parseBunTextCoverage(output: string): Map<string, number> {
	const coverage = new Map<string, number>();

	// Match lines from the coverage table: start with a non-space, contain |
	const lines = output.split("\n");
	for (const line of lines) {
		// Coverage lines look like:
		//   path/to/file.ts |  100.00 |   86.67 | ...
		const match = line.match(/^(.+?)\s+\|\s+[\d.]+\s+\|\s+([\d.]+)\s*\|/);
		if (match) {
			const filePath = match[1].trim();
			const branchPct = Number.parseFloat(match[2]);
			if (!Number.isNaN(branchPct)) {
				coverage.set(filePath, branchPct);
			}
		}
	}

	return coverage;
}

async function main(): Promise<void> {
	// Run coverage for packages that contain critical modules.
	// We run coverage for specific packages to keep it fast; the full
	// workspace coverage run can be slow and may include irrelevant files.
	const targetDirs = [
		"packages/domain/src",
		"packages/database/src",
		"packages/shared/src",
		"packages/autopilot/src",
		"packages/git/src",
		"packages/github/src",
		"apps/worker/src",
	];

	const cmd = `bun test --coverage ${targetDirs.join(" ")}`;
	const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	const output = stdout + stderr;

	const coverage = parseBunTextCoverage(output);

	if (coverage.size === 0) {
		console.error(
			"No coverage data found in Bun output. Ensure `bun test --coverage` runs successfully.",
		);
		process.exit(1);
	}

	const results: { module: string; coverage: number | string; pass: boolean }[] = [];
	let allPassed = true;

	for (const mod of CRITICAL_MODULES) {
		// Find the first file path matching this module's pattern
		let foundPath: string | null = null;
		for (const [filePath] of coverage) {
			if (mod.pathPattern.test(filePath)) {
				foundPath = filePath;
				break;
			}
		}

		const branchPct = foundPath ? (coverage.get(foundPath) ?? null) : null;
		const pass = branchPct !== null && branchPct >= THRESHOLD;

		results.push({
			module: mod.name,
			coverage: branchPct !== null ? `${branchPct.toFixed(2)}%` : "not found",
			pass,
		});

		if (!pass) allPassed = false;
	}

	// Print results
	console.log(`\nCritical Module Branch Coverage (threshold: ${THRESHOLD}%)\n`);
	console.log("Module".padEnd(48), "Coverage".padEnd(12), "Status");
	console.log("-".repeat(68));

	for (const r of results) {
		const status = r.pass ? "✓ PASS" : "✗ FAIL";
		console.log(r.module.padEnd(48), String(r.coverage).padEnd(12), status);
	}

	console.log("-".repeat(68));

	if (!allPassed) {
		const failed = results.filter((r) => !r.pass);
		console.error(`\n${failed.length} module(s) below ${THRESHOLD}% branch coverage threshold:`);
		for (const f of failed) {
			console.error(`  - ${f.module}: ${f.coverage}`);
		}
		console.error("\nAdd tests for uncovered branches, then re-run this script.");
		process.exit(1);
	}

	console.log(`\nAll ${results.length} critical modules meet ${THRESHOLD}% branch coverage. ✓`);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
