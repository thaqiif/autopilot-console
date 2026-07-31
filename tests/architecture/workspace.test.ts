import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const APPS = ["web", "api", "worker"] as const;
const PACKAGES = ["database", "domain", "shared", "autopilot", "github", "git"] as const;
const ALL_WORKSPACES = [
	...APPS.map((name) => `apps/${name}`),
	...PACKAGES.map((name) => `packages/${name}`),
] as const;

const REQUIRED_ROOT_SCRIPTS = ["test", "typecheck", "lint", "coverage", "build"] as const;

const CRITICAL_COVERAGE_PACKAGES = [
	"domain",
	"database",
	"shared",
	"autopilot",
	"github",
	"git",
] as const;

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function packageJsonPath(workspace: string): string {
	return join(ROOT, workspace, "package.json");
}

function tsconfigPath(workspace: string): string {
	return join(ROOT, workspace, "tsconfig.json");
}

describe("workspace bootstrap", () => {
	test("root package.json declares Bun workspaces for all apps and packages", () => {
		const rootPkgPath = join(ROOT, "package.json");
		expect(existsSync(rootPkgPath)).toBe(true);

		const rootPkg = readJson(rootPkgPath);
		const workspaces = rootPkg.workspaces;
		expect(workspaces).toBeDefined();

		const patterns = Array.isArray(workspaces)
			? workspaces
			: ((workspaces as { packages?: string[] }).packages ?? []);

		expect(patterns).toEqual(expect.arrayContaining(["apps/*", "packages/*"]));

		for (const workspace of ALL_WORKSPACES) {
			expect(existsSync(packageJsonPath(workspace))).toBe(true);
		}
	});

	test("every workspace has an unambiguous package name and private flag", () => {
		const names = new Set<string>();

		for (const workspace of ALL_WORKSPACES) {
			const pkg = readJson(packageJsonPath(workspace));
			expect(typeof pkg.name).toBe("string");
			expect((pkg.name as string).length).toBeGreaterThan(0);
			expect(pkg.private).toBe(true);
			expect(names.has(pkg.name as string)).toBe(false);
			names.add(pkg.name as string);
		}

		expect(names.size).toBe(ALL_WORKSPACES.length);
	});

	test("root scripts run test, typecheck, lint, coverage, and build across the workspace", () => {
		const rootPkg = readJson(join(ROOT, "package.json"));
		const scripts = rootPkg.scripts as Record<string, string> | undefined;
		expect(scripts).toBeDefined();

		for (const script of REQUIRED_ROOT_SCRIPTS) {
			expect(typeof scripts?.[script]).toBe("string");
			expect((scripts?.[script] ?? "").trim().length).toBeGreaterThan(0);
		}

		// Workspace-spanning scripts must fail the root when a package fails
		for (const script of ["test", "typecheck", "build"] as const) {
			const body = scripts?.[script] ?? "";
			expect(
				body.includes("--filter") ||
					body.includes("--workspaces") ||
					body.includes("workspace") ||
					body.includes("bun test") ||
					body.includes("turbo") ||
					body.includes("nx"),
			).toBe(true);
		}
		// Root lint is a single Biome pass over the monorepo
		expect((scripts?.lint ?? "").toLowerCase()).toMatch(/biome/);
	});

	test("root tests delegate to workspace suites without discovering Playwright specs", () => {
		const rootPkg = readJson(join(ROOT, "package.json"));
		const testScript = ((rootPkg.scripts as Record<string, string>).test ?? "").trim();

		expect(testScript).toMatch(/bun run --filter ['"]?\*['"]?(?: --sequential)? test/);
		expect(testScript).toMatch(/bun test tests/);
		expect(testScript).not.toBe("bun test");
	});

	test("diagnostic scripts cannot masquerade as repository tests", () => {
		const testsRoot = join(ROOT, "tests");
		const discovered: string[] = [];
		const stack = [testsRoot];

		while (stack.length > 0) {
			const current = stack.pop() as string;
			for (const entry of readdirSync(current)) {
				const full = join(current, entry);
				if (statSync(full).isDirectory()) {
					stack.push(full);
				} else if (/^debug.*\.test\.[jt]sx?$/.test(entry)) {
					discovered.push(full);
				}
			}
		}

		expect(discovered).toEqual([]);
	});

	test("web package exposes explicit dev and browser-test commands", () => {
		const webPkg = readJson(packageJsonPath("apps/web"));
		const scripts = webPkg.scripts as Record<string, string>;
		expect(scripts.dev).toMatch(/vite/);
		expect(scripts.e2e).toMatch(/playwright test/);
	});

	test("TypeScript strict mode and consistent module resolution apply to every package", () => {
		const basePath = join(ROOT, "tsconfig.base.json");
		expect(existsSync(basePath)).toBe(true);

		const base = readJson(basePath);
		const compilerOptions = base.compilerOptions as Record<string, unknown> | undefined;
		expect(compilerOptions).toBeDefined();
		expect(compilerOptions?.strict).toBe(true);
		expect(compilerOptions?.moduleResolution).toBeDefined();
		expect(compilerOptions?.noEmit).toBe(true);
		expect(compilerOptions?.skipLibCheck).toBe(true);

		for (const workspace of ALL_WORKSPACES) {
			const tsconfigFile = tsconfigPath(workspace);
			expect(existsSync(tsconfigFile)).toBe(true);
			const tsconfig = readJson(tsconfigFile);
			const extendsField = tsconfig.extends;
			expect(typeof extendsField).toBe("string");
			expect(extendsField as string).toMatch(/tsconfig\.base\.json$/);

			const localOptions = (tsconfig.compilerOptions ?? {}) as Record<string, unknown>;
			// Packages must not disable strict mode locally
			if ("strict" in localOptions) {
				expect(localOptions.strict).toBe(true);
			}
		}
	});

	test("coverage configuration can enforce branch thresholds for critical packages", () => {
		const bunfigPath = join(ROOT, "bunfig.toml");
		expect(existsSync(bunfigPath)).toBe(true);

		const bunfig = readFileSync(bunfigPath, "utf8");
		// Bun coverage lives under [test] with coverageThreshold + ignore patterns
		expect(bunfig).toMatch(/\[test\]/);
		expect(bunfig).toMatch(/coverageThreshold/);
		// Generated migrations/fixtures must not count toward thresholds
		expect(bunfig).toMatch(/coveragePathIgnorePatterns/);
		expect(bunfig.toLowerCase()).toMatch(/migration|fixture/);

		const rootPkg = readJson(join(ROOT, "package.json"));
		const coverageScript = (rootPkg.scripts as Record<string, string>).coverage;
		expect(coverageScript).toMatch(/--coverage|coverage/);

		// Critical packages are present so thresholds can target them later
		for (const name of CRITICAL_COVERAGE_PACKAGES) {
			expect(existsSync(packageJsonPath(`packages/${name}`))).toBe(true);
		}
	});

	test("Biome lint configuration exists and root lint script invokes it", () => {
		const biomePath = join(ROOT, "biome.json");
		expect(existsSync(biomePath)).toBe(true);

		const biome = readJson(biomePath);
		expect(biome).toBeDefined();

		const rootPkg = readJson(join(ROOT, "package.json"));
		const lintScript = (rootPkg.scripts as Record<string, string>).lint;
		expect(lintScript.toLowerCase()).toMatch(/biome/);
	});

	test("apps do not depend on other apps; dependency boundaries stay package-scoped", () => {
		const appNames = new Set(
			APPS.map((name) => {
				const pkg = readJson(packageJsonPath(`apps/${name}`));
				return pkg.name as string;
			}),
		);

		for (const app of APPS) {
			const pkg = readJson(packageJsonPath(`apps/${app}`));
			const allDeps = {
				...(pkg.dependencies as Record<string, string> | undefined),
				...(pkg.devDependencies as Record<string, string> | undefined),
				...(pkg.peerDependencies as Record<string, string> | undefined),
			};

			for (const dep of Object.keys(allDeps)) {
				expect(appNames.has(dep) && dep !== pkg.name).toBe(false);
			}
		}
	});

	test("workspace package scripts expose typecheck, test, and lint", () => {
		for (const workspace of ALL_WORKSPACES) {
			const pkg = readJson(packageJsonPath(workspace));
			const scripts = (pkg.scripts ?? {}) as Record<string, string>;
			expect(typeof scripts.typecheck).toBe("string");
			expect(typeof scripts.test).toBe("string");
			expect(typeof scripts.lint).toBe("string");
		}
	});

	test("no empty source stubs masquerade as packages during bootstrap", () => {
		// Bootstrap may ship entrypoints, but they must be real modules (non-empty files)
		// and must not contain TODO/FIXME/placeholder markers.
		const forbidden = /\b(TODO|FIXME|not implemented|throw new Error\(["']not implemented)/i;

		for (const workspace of ALL_WORKSPACES) {
			const srcDir = join(ROOT, workspace, "src");
			if (!existsSync(srcDir)) {
				// Pure config packages without src are fine at bootstrap if package.json is complete
				continue;
			}

			const stack = [srcDir];
			while (stack.length > 0) {
				const current = stack.pop() as string;
				for (const entry of readdirSync(current)) {
					const full = join(current, entry);
					const stat = statSync(full);
					if (stat.isDirectory()) {
						stack.push(full);
						continue;
					}
					if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) continue;
					const body = readFileSync(full, "utf8");
					expect(body.trim().length).toBeGreaterThan(0);
					expect(forbidden.test(body)).toBe(false);
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Requirement 48: Phase 1 release-qualification gate
// ---------------------------------------------------------------------------

describe("Phase 1 release qualification (requirement 48)", () => {
	const REQUIRED_GATES = [
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
	] as const;

	test("root package.json exposes verify:phase-1 that invokes scripts/verify-phase-1.ts", () => {
		const rootPkg = readJson(join(ROOT, "package.json"));
		const scripts = (rootPkg.scripts ?? {}) as Record<string, string>;
		expect(typeof scripts["verify:phase-1"]).toBe("string");
		expect(scripts["verify:phase-1"]).toMatch(/verify-phase-1/);
		expect(existsSync(join(ROOT, "scripts/verify-phase-1.ts"))).toBe(true);
	});

	test("qualification script declares every named gate and fails closed language", () => {
		const body = readFileSync(join(ROOT, "scripts/verify-phase-1.ts"), "utf8");
		for (const gate of REQUIRED_GATES) {
			expect(body).toContain(`"${gate}"`);
		}
		expect(body).toMatch(/fail(?:s|ed)? closed|actionable/i);
		// Skip detection must reject skipped critical tests
		expect(body).toMatch(/detectSkippedTests|skip/i);
	});

	test("assertQualificationScriptContract and assertDocumentationAlignment pass on the live tree", async () => {
		const {
			assertDocumentationAlignment,
			assertQualificationScriptContract,
			PHASE1_GATES,
			runPhase1Qualification,
		} = await import("../../scripts/verify-phase-1");

		expect([...PHASE1_GATES]).toEqual([...REQUIRED_GATES]);

		const script = assertQualificationScriptContract(ROOT);
		expect(script.ok).toBe(true);
		expect(script.messages).toEqual([]);

		const docs = assertDocumentationAlignment(ROOT);
		expect(docs.ok).toBe(true);
		expect(docs.messages).toEqual([]);

		// Static-only pass proves the contract wiring without re-running the full suite
		// inside the unit test process.
		const summary = await runPhase1Qualification({ staticOnly: true, root: ROOT });
		expect(summary.ok).toBe(true);
		expect(summary.command).toBe("bun run verify:phase-1");
		expect(summary.gates.map((g) => g.name)).toEqual([...REQUIRED_GATES]);
	});

	test("qualification fails closed when a required gate is missing from the package script surface", async () => {
		const { assertQualificationScriptContract } = await import("../../scripts/verify-phase-1");
		// Point at a temporary root without the script to prove fail-closed messaging.
		const tmp = join(ROOT, "coverage", "req-48-missing-script");
		const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
		const result = assertQualificationScriptContract(tmp);
		expect(result.ok).toBe(false);
		expect(result.messages.join(" ")).toMatch(/verify:phase-1/);
		rmSync(tmp, { recursive: true, force: true });
	});

	test("README, deployment, operations, changelog, and ledger document the same qualification command", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const deployment = readFileSync(join(ROOT, "docs/deployment.md"), "utf8");
		const operations = readFileSync(join(ROOT, "docs/operations.md"), "utf8");
		const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
		const ledger = readFileSync(
			join(ROOT, "docs/autopilotagent/autopilot-console-phase-1/autopilot-console-phase-1.json"),
			"utf8",
		);

		for (const doc of [readme, deployment, operations]) {
			expect(doc).toMatch(/verify:phase-1|verify-phase-1/);
		}
		expect(changelog).toMatch(/verify:phase-1|release.?qualification|requirement 48/i);
		// Ledger tracks requirement 48 (this requirement)
		expect(ledger).toMatch(/"id":\s*"48"/);
		expect(ledger).toMatch(/release-qualification|verify-phase-1/);
	});
});
