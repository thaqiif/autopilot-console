import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const APPS = ["web", "api", "worker"] as const;
const PACKAGES = [
	"database",
	"domain",
	"shared",
	"autopilot",
	"github",
	"git",
] as const;
const ALL_WORKSPACES = [
	...APPS.map((name) => `apps/${name}`),
	...PACKAGES.map((name) => `packages/${name}`),
] as const;

const REQUIRED_ROOT_SCRIPTS = [
	"test",
	"typecheck",
	"lint",
	"coverage",
	"build",
] as const;

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

		expect(patterns).toEqual(
			expect.arrayContaining(["apps/*", "packages/*"]),
		);

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

		// Scripts must fail the root when a package fails (filter/workspace runners)
		for (const script of ["test", "typecheck", "lint", "build"] as const) {
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
	});

	test("TypeScript strict mode and consistent module resolution apply to every package", () => {
		const basePath = join(ROOT, "tsconfig.base.json");
		expect(existsSync(basePath)).toBe(true);

		const base = readJson(basePath);
		const compilerOptions = base.compilerOptions as
			| Record<string, unknown>
			| undefined;
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

			const localOptions = (tsconfig.compilerOptions ?? {}) as Record<
				string,
				unknown
			>;
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
		expect(bunfig).toMatch(/\[test\.coverage\]/i);
		expect(bunfig.toLowerCase()).toMatch(/threshold/);
		// Generated migrations/fixtures must not count toward thresholds
		expect(bunfig.toLowerCase()).toMatch(/skip|exclude|ignore/);

		const rootPkg = readJson(join(ROOT, "package.json"));
		const coverageScript = (rootPkg.scripts as Record<string, string>)
			.coverage;
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
		const forbidden = /\b(TODO|FIXME|placeholder|not implemented|throw new Error\(["']not implemented)/i;

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
