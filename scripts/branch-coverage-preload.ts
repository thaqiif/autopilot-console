import { afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInstrumenter } from "istanbul-lib-instrument";

const outputPath = process.env.PHASE1_BRANCH_COVERAGE_FILE;
if (!outputPath) {
	throw new Error("PHASE1_BRANCH_COVERAGE_FILE is required for critical branch instrumentation");
}

declare global {
	var __coverage__: Record<string, unknown> | undefined;
}

const sourceFilter =
	/(?:feature-state-machine|feature-service|release-service|project-service|task-approval-service|attention-policy|failure-policy|development-progress|development-queue|lease-reconciler|workspace-path|task-path|cancellation-controller|retry-service|process-tree|orphan-reconciler|cli-git-gateway|gh-cli-gateway|cli-autopilot-runner)\.ts$/;
Bun.plugin({
	name: "phase1-istanbul-branch-coverage",
	setup(builder) {
		builder.onLoad({ filter: sourceFilter }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const instrumenter = createInstrumenter({
				coverageVariable: "__coverage__",
				coverageGlobalScope: "globalThis",
				coverageGlobalScopeFunc: false,
				compact: true,
				esModules: true,
				produceSourceMap: false,
				parserPlugins: ["typescript", "jsx"],
			});
			return {
				contents: instrumenter.instrumentSync(source, path),
				loader: path.endsWith(".tsx") ? "tsx" : "ts",
			};
		});
	},
});

function flushCoverage(): void {
	mkdirSync(dirname(outputPath), { recursive: true });
	const current = globalThis.__coverage__ ?? {};
	const previousBody = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
	const previous = previousBody
		? (JSON.parse(previousBody) as Record<string, Record<string, unknown>>)
		: {};
	for (const [filePath, rawFile] of Object.entries(current)) {
		const file = rawFile as Record<string, unknown>;
		const prior = previous[filePath];
		if (!prior) {
			previous[filePath] = file;
			continue;
		}
		const branchCounts = file.b as Record<string, number[]> | undefined;
		const priorCounts = prior.b as Record<string, number[]> | undefined;
		if (branchCounts && priorCounts) {
			for (const [branchId, counts] of Object.entries(branchCounts)) {
				const old = priorCounts[branchId] ?? [];
				priorCounts[branchId] = counts.map((count, index) => Math.max(count, old[index] ?? 0));
			}
		}
	}
	writeFileSync(outputPath, `${JSON.stringify(previous, null, 2)}\n`);
}

afterAll(flushCoverage);
process.on("exit", flushCoverage);
