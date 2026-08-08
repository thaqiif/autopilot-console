/**
 * Phase 1 release-qualification command (requirement 48).
 *
 * Run: bun run verify:phase-1
 *      bun run scripts/verify-phase-1.ts
 *
 * One reproducible gate that fails closed when any required dependency or
 * named gate is missing, skipped, unavailable, or failing. Produces a concise
 * machine-readable summary on stdout (and optionally a JSON file).
 *
 * Named gates (in order):
 *   dependencies → typecheck → lint → unit → database → process →
 *   browser → coverage → build → migrations → image → compose → deployment-smoke
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

/** Ordered Phase 1 qualification gates. Keep in sync with docs and contract tests. */
export const PHASE1_GATES = [
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

export type Phase1GateName = (typeof PHASE1_GATES)[number];

export interface GateRunResult {
	name: Phase1GateName;
	ok: boolean;
	durationMs: number;
	exitCode: number;
	/** Actionable operator message when the gate fails. */
	message?: string;
	/** Truncated command output retained for diagnosis. */
	outputTail?: string;
}

export interface QualificationSummary {
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	gates: GateRunResult[];
	/** Echo of the documented command used to invoke this script. */
	command: string;
	/** Environment dependency checks performed before suites. */
	dependencies: Record<string, { ok: boolean; detail: string }>;
}

export interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface VerifyOptions {
	/** Override command execution (unit tests inject fakes). */
	spawn?: (
		cmd: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	) => Promise<SpawnResult>;
	/** Override wall-clock (tests). */
	now?: () => Date;
	/** Root of the monorepo. */
	root?: string;
	/** Skip running later gates after the first failure (default true). */
	failFast?: boolean;
	/** Write JSON summary to this path when set. */
	summaryPath?: string;
	/** Extra env merged into every spawned process. */
	env?: Record<string, string>;
	/**
	 * When true, only evaluate static contracts (source/package/docs) without
	 * spawning heavy suites. Used by architecture contract tests.
	 */
	staticOnly?: boolean;
}

const DEFAULT_DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console";

const OUTPUT_TAIL = 4_000;

export function qualificationEnvironment(
	source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value !== undefined) env[name] = value;
	}
	env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
	return env;
}

function defaultNow(): Date {
	return new Date();
}

export async function defaultSpawn(
	cmd: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd ?? ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			...options.env,
		},
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

function tail(text: string, max = OUTPUT_TAIL): string {
	if (text.length <= max) return text;
	return `…[truncated]\n${text.slice(-max)}`;
}

function combined(result: SpawnResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

/** Detect Bun/Playwright skip markers that must fail closed under qualification. */
export function detectSkippedTests(output: string): string[] {
	const skipped: string[] = [];
	for (const line of output.split("\n")) {
		const m = line.match(/^\s*\(skip\)\s+(.+?)\s*$/);
		if (m) skipped.push(m[1].trim());
	}
	const summary = output.match(/^\s*(\d+)\s+skip\s*$/m);
	if (summary && Number(summary[1]) > 0 && skipped.length === 0) {
		skipped.push(`${summary[1]} skipped test(s) (names not listed)`);
	}
	return skipped;
}

export function hasSkipSummary(output: string): boolean {
	const m = output.match(/^\s*(\d+)\s+skip\s*$/m);
	return Boolean(m && Number(m[1]) > 0);
}

function readRootPackage(root: string): {
	scripts?: Record<string, string>;
	workspaces?: string[] | { packages?: string[] };
} {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
		workspaces?: string[] | { packages?: string[] };
	};
}

/** Static contract: root package exposes the documented qualification script. */
export function assertQualificationScriptContract(root = ROOT): {
	ok: boolean;
	messages: string[];
	scriptBody: string;
} {
	const messages: string[] = [];
	const pkg = readRootPackage(root);
	const scripts = pkg.scripts ?? {};
	const scriptBody = scripts["verify:phase-1"] ?? "";
	if (!scriptBody.trim()) {
		messages.push(
			'Root package.json is missing a non-empty "verify:phase-1" script. Add: "verify:phase-1": "bun run scripts/verify-phase-1.ts"',
		);
	} else if (!/verify-phase-1/.test(scriptBody)) {
		messages.push(`"verify:phase-1" must invoke scripts/verify-phase-1.ts (got: ${scriptBody}).`);
	}

	const scriptPath = join(root, "scripts/verify-phase-1.ts");
	if (!existsSync(scriptPath)) {
		messages.push("scripts/verify-phase-1.ts is missing.");
	} else {
		const body = readFileSync(scriptPath, "utf8");
		for (const gate of PHASE1_GATES) {
			if (!body.includes(`"${gate}"`) && !body.includes(`'${gate}'`)) {
				messages.push(`scripts/verify-phase-1.ts does not declare gate "${gate}".`);
			}
		}
		// Fail-closed language must be present for operator messaging.
		if (!/fail(?:s|ed)? closed|actionable/i.test(body)) {
			messages.push(
				"Qualification script must document fail-closed / actionable failure behavior.",
			);
		}
		if (!body.includes("./packages/autopilot/src/runner/installed-cli.contract.ts")) {
			messages.push("Qualification must execute the installed Autopilotagent CLI contract.");
		}
	}
	const installedContract = join(root, "packages/autopilot/src/runner/installed-cli.contract.ts");
	if (!existsSync(installedContract)) {
		messages.push("Installed Autopilotagent CLI contract is missing.");
	} else if (/AUTOPILOT_INSTALLED_CLI_TEST|opt-in/i.test(readFileSync(installedContract, "utf8"))) {
		messages.push("Installed Autopilotagent CLI contract must not be opt-in during qualification.");
	}

	return { ok: messages.length === 0, messages, scriptBody };
}

/** Static contract: operator docs and ledger report the same qualification status. */
export function assertDocumentationAlignment(root = ROOT): {
	ok: boolean;
	messages: string[];
} {
	const messages: string[] = [];
	const requiredFiles = [
		"README.md",
		"docs/deployment.md",
		"docs/operations.md",
		"CHANGELOG.md",
		"docs/autopilotagent/autopilot-console-phase-1/autopilot-console-phase-1.json",
	];
	for (const rel of requiredFiles) {
		if (!existsSync(join(root, rel))) {
			messages.push(`Required documentation file missing: ${rel}`);
		}
	}

	const readme = existsSync(join(root, "README.md"))
		? readFileSync(join(root, "README.md"), "utf8")
		: "";
	const deployment = existsSync(join(root, "docs/deployment.md"))
		? readFileSync(join(root, "docs/deployment.md"), "utf8")
		: "";
	const operations = existsSync(join(root, "docs/operations.md"))
		? readFileSync(join(root, "docs/operations.md"), "utf8")
		: "";
	const changelog = existsSync(join(root, "CHANGELOG.md"))
		? readFileSync(join(root, "CHANGELOG.md"), "utf8")
		: "";
	const ledgerPath = join(
		root,
		"docs/autopilotagent/autopilot-console-phase-1/autopilot-console-phase-1.json",
	);
	let ledgerQualified = false;
	if (existsSync(ledgerPath)) {
		try {
			const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
				requirements?: Array<{ id?: string; passes?: boolean }>;
			};
			ledgerQualified =
				ledger.requirements?.find((requirement) => requirement.id === "48")?.passes === true;
		} catch {
			messages.push("Phase 1 requirement ledger is not valid JSON.");
		}
	}
	const statusMarker = `Phase 1 qualification status: ${ledgerQualified ? "QUALIFIED" : "NOT QUALIFIED"}`;
	for (const [relativePath, body] of [
		["README.md", readme],
		["docs/deployment.md", deployment],
		["docs/operations.md", operations],
		["CHANGELOG.md", changelog],
	] as const) {
		if (!body.includes(statusMarker)) {
			messages.push(`${relativePath} must report the ledger status exactly: ${statusMarker}`);
		}
	}

	if (!/verify:phase-1|verify-phase-1/i.test(readme)) {
		messages.push("README.md must document the Phase 1 qualification command (verify:phase-1).");
	}
	if (!/verify:phase-1|verify-phase-1|release.?qualification/i.test(deployment)) {
		messages.push(
			"docs/deployment.md must document Phase 1 release qualification (verify:phase-1).",
		);
	}
	if (!/verify:phase-1|verify-phase-1|qualification/i.test(operations)) {
		messages.push("docs/operations.md must reference the Phase 1 qualification command.");
	}
	if (!/verify:phase-1|release.?qualification|requirement 48/i.test(changelog)) {
		messages.push("CHANGELOG.md must record Phase 1 release qualification (requirement 48).");
	}

	// Ledger and docs must not claim open qualification when the command exists,
	// and must not claim production-complete beyond Development Merged.
	if (/production-ready|fully released/i.test(readme) && /Phase 1/i.test(readme)) {
		messages.push(
			"README.md must not claim Phase 1 is production-released beyond Development Merged.",
		);
	}

	return { ok: messages.length === 0, messages };
}

async function checkPostgres(
	spawn: NonNullable<VerifyOptions["spawn"]>,
	databaseUrl: string,
): Promise<{ ok: boolean; detail: string }> {
	const result = await spawn(
		[
			"bun",
			"-e",
			`
import postgres from "postgres";
const url = process.env.DATABASE_URL;
const sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 2 });
try {
  await sql\`select 1\`;
  console.log("postgres-ok");
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await sql.end({ timeout: 2 });
}
`,
		],
		{ env: { DATABASE_URL: databaseUrl } },
	);
	if (result.exitCode === 0 && /postgres-ok/.test(result.stdout)) {
		return { ok: true, detail: `reachable at DATABASE_URL` };
	}
	return {
		ok: false,
		detail:
			`PostgreSQL unavailable at DATABASE_URL (${databaseUrl}): ${combined(result) || "connection failed"}. ` +
			`Provision a reachable database (default postgres://postgres:postgres@127.0.0.1:5432/autopilot_console) before qualification.`,
	};
}

async function checkDockerCli(
	spawn: NonNullable<VerifyOptions["spawn"]>,
): Promise<{ ok: boolean; detail: string }> {
	const which = await spawn(["bash", "-lc", "command -v docker"]);
	if (which.exitCode !== 0 || !which.stdout.trim()) {
		return {
			ok: false,
			detail:
				"docker CLI not found on PATH. Install Docker 24+ / Compose v2.20+ for image and Compose gates.",
		};
	}
	// `docker version` exits non-zero when the daemon is down but still prints the
	// client version. Prefer compose version (CLI plugin) which does not need a daemon.
	const compose = await spawn(["docker", "compose", "version"]);
	const composeOut = combined(compose);
	if (compose.exitCode === 0 || /Docker Compose version/i.test(composeOut)) {
		const daemon = await spawn(["docker", "info", "--format", "{{.ServerVersion}}"]);
		if (daemon.exitCode === 0 && daemon.stdout.trim()) {
			return {
				ok: true,
				detail: `${composeOut.split("\n")[0]?.trim() || "docker compose available"}; daemon ${daemon.stdout.trim()}`,
			};
		}
		return {
			ok: false,
			detail:
				`Docker daemon unavailable: ${combined(daemon) || "docker info failed"}. ` +
				"Start a Docker daemon before Phase 1 qualification; image and fresh-stack gates cannot be skipped.",
		};
	}
	const version = await spawn(["docker", "version", "--format", "{{.Client.Version}}"]);
	const clientVersion = version.stdout.trim();
	if (clientVersion) {
		return {
			ok: true,
			detail: `docker client ${clientVersion} (daemon may be unavailable; image gate uses static build-graph checks)`,
		};
	}
	return {
		ok: false,
		detail: `docker CLI present but not usable: ${combined(version) || composeOut}`,
	};
}

async function checkPlaywrightBrowser(root: string): Promise<{ ok: boolean; detail: string }> {
	const candidates = [
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		"/opt/ms-playwright/chromium-1228/chrome-linux64/chrome",
		join(root, "node_modules/@playwright/browser-chromium"),
		"/home/agent/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
		"/usr/bin/google-chrome",
	].filter(Boolean) as string[];
	for (const c of candidates) {
		if (existsSync(c)) {
			return { ok: true, detail: `browser binary available (${c})` };
		}
	}
	return {
		ok: false,
		detail:
			"Playwright Chromium binary not found. Install browsers (bunx playwright install chromium) " +
			"or set PLAYWRIGHT_CHROMIUM_EXECUTABLE. Browser E2E cannot be skipped under Phase 1 qualification.",
	};
}

async function checkBun(): Promise<{ ok: boolean; detail: string }> {
	if (typeof Bun === "undefined") {
		return { ok: false, detail: "Bun runtime required (this script must run under Bun)." };
	}
	return { ok: true, detail: `bun ${Bun.version}` };
}

async function runCommandGate(
	name: Phase1GateName,
	cmd: string[],
	spawn: NonNullable<VerifyOptions["spawn"]>,
	env: Record<string, string>,
	root: string,
	started: number,
): Promise<GateRunResult> {
	const result = await spawn(cmd, { cwd: root, env });
	const output = combined(result);
	const skipped = detectSkippedTests(output);
	const durationMs = Date.now() - started;
	if (result.exitCode !== 0) {
		return {
			name,
			ok: false,
			durationMs,
			exitCode: result.exitCode,
			message: `Gate "${name}" failed (exit ${result.exitCode}). Command: ${cmd.join(" ")}. Fix the failing suite before claiming Phase 1 qualification.`,
			outputTail: tail(output),
		};
	}
	if (skipped.length > 0 || hasSkipSummary(output)) {
		return {
			name,
			ok: false,
			durationMs,
			exitCode: 1,
			message:
				`Gate "${name}" reported skipped tests — no critical test may be skipped or opt-in when Phase 1 qualification is claimed. ` +
				`Skipped: ${skipped.slice(0, 10).join("; ") || "see summary"}.`,
			outputTail: tail(output),
		};
	}
	return {
		name,
		ok: true,
		durationMs,
		exitCode: 0,
		outputTail: tail(output),
	};
}

function composeEnv(base: Record<string, string>): Record<string, string> {
	// Provide deterministic non-secret placeholders so `docker compose config`
	// and build --check can render without a local .env. Real deployments must
	// still supply strong values via .env as documented.
	return {
		POSTGRES_PASSWORD: base.POSTGRES_PASSWORD ?? "phase1-qualify-password",
		SESSION_SECRET: base.SESSION_SECRET ?? "phase1-qualify-session-secret",
		ADMIN_BOOTSTRAP_PASSWORD: base.ADMIN_BOOTSTRAP_PASSWORD ?? "Change-Me-123!",
		AUTOPILOTAGENT_MOUNT: base.AUTOPILOTAGENT_MOUNT ?? "/opt/autopilot-multi",
		WORKSPACE_MOUNT: base.WORKSPACE_MOUNT ?? join(ROOT, "projects"),
		GH_TOKEN: base.GH_TOKEN ?? base.GITHUB_TOKEN ?? "phase1-qualify-token",
		GITHUB_TOKEN: base.GITHUB_TOKEN ?? base.GH_TOKEN ?? "phase1-qualify-token",
		AGENT_BIN: base.AGENT_BIN ?? "cmd",
		COMPOSE_PROJECT_NAME: base.COMPOSE_PROJECT_NAME ?? "autopilot-console-phase1-qualification",
		POSTGRES_PORT: base.POSTGRES_PORT ?? "55432",
		API_PORT: base.API_PORT ?? "33000",
		WEB_PORT: base.WEB_PORT ?? "38080",
		...base,
	};
}

function failedGate(
	name: "compose" | "deployment-smoke",
	started: number,
	message: string,
	output = "",
): GateRunResult {
	return {
		name,
		ok: false,
		durationMs: Date.now() - started,
		exitCode: 1,
		message,
		outputTail: tail(output),
	};
}

/**
 * Qualify an isolated Compose deployment from empty volumes, exercise all live
 * health endpoints and a PostgreSQL dump/restore, and always remove the stack.
 */
export async function runComposeStackQualification(
	spawn: NonNullable<VerifyOptions["spawn"]>,
	root: string,
	baseEnv: Record<string, string>,
): Promise<{ compose: GateRunResult; deployment: GateRunResult }> {
	const started = Date.now();
	const env = composeEnv(baseEnv);
	const down = ["docker", "compose", "down", "--volumes", "--remove-orphans", "--timeout", "10"];
	let compose: GateRunResult | undefined;
	let deployment: GateRunResult | undefined;

	try {
		const clean = await spawn(down, { cwd: root, env });
		if (clean.exitCode !== 0) {
			const output = combined(clean);
			compose = failedGate(
				"compose",
				started,
				`Compose gate failed — could not reset the isolated qualification stack: ${tail(output)}`,
				output,
			);
			deployment = failedGate(
				"deployment-smoke",
				started,
				"Deployment smoke was not executed because isolated-stack cleanup failed.",
			);
			return { compose, deployment };
		}

		const config = await spawn(["docker", "compose", "config", "-q"], { cwd: root, env });
		if (config.exitCode !== 0) {
			const output = combined(config);
			compose = failedGate(
				"compose",
				started,
				`Compose gate failed — configuration is invalid: ${tail(output)}`,
				output,
			);
			deployment = failedGate(
				"deployment-smoke",
				started,
				"Deployment smoke was not executed because Compose configuration is invalid.",
			);
			return { compose, deployment };
		}

		const up = await spawn(["docker", "compose", "up", "-d", "--wait", "--wait-timeout", "120"], {
			cwd: root,
			env,
		});
		if (up.exitCode !== 0) {
			const output = combined(up);
			compose = failedGate(
				"compose",
				started,
				`Compose gate failed — the fresh stack did not become healthy: ${tail(output)}`,
				output,
			);
			deployment = failedGate(
				"deployment-smoke",
				started,
				"Deployment smoke was not executed because the fresh Compose stack was unhealthy.",
			);
			return { compose, deployment };
		}

		const ps = await spawn(["docker", "compose", "ps", "--all", "--format", "json"], {
			cwd: root,
			env,
		});
		const psOutput = combined(ps);
		const requiredServices = ["postgres", "migrate", "api", "worker", "web"];
		const missing = requiredServices.filter(
			(service) => !new RegExp(`"Service"\\s*:\\s*"${service}"`).test(psOutput),
		);
		if (ps.exitCode !== 0 || missing.length > 0) {
			compose = failedGate(
				"compose",
				started,
				missing.length > 0
					? `Compose gate failed — running stack omitted services: ${missing.join(", ")}.`
					: `Compose gate failed — service inspection failed: ${tail(psOutput)}`,
				psOutput,
			);
			deployment = failedGate(
				"deployment-smoke",
				started,
				"Deployment smoke was not executed because service inspection failed.",
			);
			return { compose, deployment };
		}

		compose = {
			name: "compose",
			ok: true,
			durationMs: Date.now() - started,
			exitCode: 0,
			message: "Fresh isolated Compose stack reached healthy state with all required services.",
			outputTail: tail(psOutput),
		};

		const probes: string[][] = [
			[
				"docker",
				"compose",
				"exec",
				"-T",
				"api",
				"bun",
				"-e",
				"const r=await fetch('http://127.0.0.1:3000/api/health/live');process.exit(r.ok?0:1)",
			],
			[
				"docker",
				"compose",
				"exec",
				"-T",
				"worker",
				"bun",
				"-e",
				"const r=await fetch('http://127.0.0.1:3001/health/live');process.exit(r.ok?0:1)",
			],
			[
				"docker",
				"compose",
				"exec",
				"-T",
				"web",
				"wget",
				"-qO-",
				"http://127.0.0.1:8080/nginx-health",
			],
		];
		for (const probe of probes) {
			const result = await spawn(probe, { cwd: root, env });
			if (result.exitCode !== 0) {
				const output = combined(result);
				deployment = failedGate(
					"deployment-smoke",
					started,
					`Deployment smoke failed — live health probe failed (${probe.slice(4, 6).join(" ")}): ${tail(output)}`,
					output,
				);
				return { compose, deployment };
			}
		}

		const recovery = await spawn(
			[
				"docker",
				"compose",
				"exec",
				"-T",
				"postgres",
				"sh",
				"-euc",
				'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c \'CREATE TABLE phase1_recovery_probe (id integer PRIMARY KEY); INSERT INTO phase1_recovery_probe VALUES (1);\' && pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t phase1_recovery_probe > /tmp/phase1-recovery.sql && psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c \'DROP TABLE phase1_recovery_probe;\' && psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < /tmp/phase1-recovery.sql && test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \'SELECT count(*) FROM phase1_recovery_probe\')" = 1 && psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c \'DROP TABLE phase1_recovery_probe;\' && rm -f /tmp/phase1-recovery.sql',
			],
			{ cwd: root, env },
		);
		const recoveryOutput = combined(recovery);
		deployment =
			recovery.exitCode === 0
				? {
						name: "deployment-smoke",
						ok: true,
						durationMs: Date.now() - started,
						exitCode: 0,
						message: "API, worker, and web health probes plus PostgreSQL dump/restore succeeded.",
						outputTail: tail(recoveryOutput),
					}
				: failedGate(
						"deployment-smoke",
						started,
						`Deployment smoke failed — PostgreSQL backup/recovery probe failed: ${tail(recoveryOutput)}`,
						recoveryOutput,
					);
		return { compose, deployment };
	} finally {
		await spawn(down, { cwd: root, env });
	}
}

/**
 * Run the full Phase 1 qualification sequence.
 * Returns a machine-readable summary; exit code is 0 only when every gate passes.
 */
export async function runPhase1Qualification(
	options: VerifyOptions = {},
): Promise<QualificationSummary> {
	const root = options.root ?? ROOT;
	const spawn = options.spawn ?? defaultSpawn;
	const now = options.now ?? defaultNow;
	const failFast = options.failFast !== false;
	const startedAt = now();
	const env: Record<string, string> = {
		DATABASE_URL: DEFAULT_DATABASE_URL,
		...options.env,
	};

	const gates: GateRunResult[] = [];
	const dependencies: QualificationSummary["dependencies"] = {};

	const finish = (ok: boolean): QualificationSummary => {
		const finishedAt = now();
		return {
			ok,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			gates,
			command: "bun run verify:phase-1",
			dependencies,
		};
	};

	// ----- Static contracts (always) -----
	const scriptContract = assertQualificationScriptContract(root);
	const docsContract = assertDocumentationAlignment(root);
	if (!scriptContract.ok || !docsContract.ok) {
		const messages = [...scriptContract.messages, ...docsContract.messages];
		gates.push({
			name: "dependencies",
			ok: false,
			durationMs: 0,
			exitCode: 1,
			message: messages.join(" "),
		});
		return finish(false);
	}

	if (options.staticOnly) {
		for (const name of PHASE1_GATES) {
			gates.push({
				name,
				ok: true,
				durationMs: 0,
				exitCode: 0,
				message: "static contract only",
			});
		}
		return finish(true);
	}

	// ----- Dependency probes -----
	const depStart = Date.now();
	const bunDep = await checkBun();
	dependencies.bun = bunDep;
	const pgDep = await checkPostgres(spawn, env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
	dependencies.postgres = pgDep;
	const dockerDep = await checkDockerCli(spawn);
	dependencies.docker = dockerDep;
	const browserDep = await checkPlaywrightBrowser(root);
	dependencies.browser = browserDep;

	const depFailures = Object.entries(dependencies)
		.filter(([, v]) => !v.ok)
		.map(([, v]) => v.detail);

	if (depFailures.length > 0) {
		gates.push({
			name: "dependencies",
			ok: false,
			durationMs: Date.now() - depStart,
			exitCode: 1,
			message: `Required dependencies unavailable — qualification fails closed:\n- ${depFailures.join("\n- ")}`,
		});
		if (failFast) return finish(false);
	} else {
		gates.push({
			name: "dependencies",
			ok: true,
			durationMs: Date.now() - depStart,
			exitCode: 0,
			message: "bun, PostgreSQL, docker CLI, and Playwright browser present",
		});
	}

	const push = (result: GateRunResult): boolean => {
		gates.push(result);
		return result.ok;
	};

	const maybeStop = (ok: boolean): boolean => !ok && failFast;

	// typecheck
	{
		const t0 = Date.now();
		const r = await runCommandGate("typecheck", ["bun", "run", "typecheck"], spawn, env, root, t0);
		if (maybeStop(push(r))) return finish(false);
	}

	// lint
	{
		const t0 = Date.now();
		const r = await runCommandGate("lint", ["bun", "run", "lint"], spawn, env, root, t0);
		if (maybeStop(push(r))) return finish(false);
	}

	// unit — sequential workspace package tests (avoids public-schema races from
	// concurrent resetSchema across packages) + architecture + gate self-tests.
	// Playwright *.spec is excluded by bunfig; composition e2e is the browser gate.
	{
		const t0 = Date.now();
		const packages = await runCommandGate(
			"unit",
			["bun", "run", "--filter", "*", "--sequential", "test"],
			spawn,
			env,
			root,
			t0,
		);
		if (!packages.ok) {
			if (maybeStop(push(packages))) return finish(false);
		} else {
			const repoTests = await runCommandGate(
				"unit",
				["bun", "test", "tests", "scripts"],
				spawn,
				env,
				root,
				t0,
			);
			const merged: GateRunResult = {
				name: "unit",
				ok: packages.ok && repoTests.ok,
				durationMs: Date.now() - t0,
				exitCode: repoTests.ok ? packages.exitCode : repoTests.exitCode,
				message: repoTests.ok ? packages.message : (repoTests.message ?? packages.message),
				outputTail: [packages.outputTail, repoTests.outputTail].filter(Boolean).join("\n---\n"),
			};
			if (maybeStop(push(merged))) return finish(false);
		}
	}

	// database integration
	{
		const t0 = Date.now();
		const r = await runCommandGate(
			"database",
			["bun", "test", "packages/database"],
			spawn,
			env,
			root,
			t0,
		);
		if (maybeStop(push(r))) return finish(false);
	}

	// process / git / github / api / worker integration surface
	{
		const t0 = Date.now();
		const suites = await runCommandGate(
			"process",
			[
				"bun",
				"test",
				"apps/worker",
				"apps/api",
				"packages/git",
				"packages/github",
				"packages/autopilot",
				"tests/integration",
			],
			spawn,
			env,
			root,
			t0,
		);
		if (!suites.ok) {
			if (maybeStop(push(suites))) return finish(false);
		} else {
			const installedCli = await runCommandGate(
				"process",
				["bun", "test", "./packages/autopilot/src/runner/installed-cli.contract.ts"],
				spawn,
				env,
				root,
				t0,
			);
			const merged: GateRunResult = {
				name: "process",
				ok: suites.ok && installedCli.ok,
				durationMs: Date.now() - t0,
				exitCode: installedCli.ok ? suites.exitCode : installedCli.exitCode,
				message: installedCli.ok ? suites.message : (installedCli.message ?? suites.message),
				outputTail: [suites.outputTail, installedCli.outputTail].filter(Boolean).join("\n---\n"),
			};
			if (maybeStop(push(merged))) return finish(false);
		}
	}

	// browser E2E — Playwright (apps/web) + production composition specs under tests/e2e
	{
		const t0 = Date.now();
		const browserEnv = {
			...env,
			// Playwright owns this strict port and fails safely if it is unavailable.
			PLAYWRIGHT_PORT: env.PLAYWRIGHT_PORT ?? "4173",
			PHASE1_QUALIFICATION: "1",
		};
		const playwright = await runCommandGate(
			"browser",
			["bun", "run", "--filter", "@autopilot-console/web", "e2e"],
			spawn,
			browserEnv,
			root,
			t0,
		);
		if (!playwright.ok) {
			if (maybeStop(push(playwright))) return finish(false);
		} else {
			// Composition e2e uses bun:test (not Playwright); invoke explicitly because
			// bunfig excludes **/e2e/** from default discovery.
			const composition = await runCommandGate(
				"browser",
				["bun", "test", "tests/e2e"],
				spawn,
				env,
				root,
				t0,
			);
			// Merge outcomes under single browser gate entry
			const merged: GateRunResult = {
				name: "browser",
				ok: playwright.ok && composition.ok,
				durationMs: Date.now() - t0,
				exitCode: composition.ok ? playwright.exitCode : composition.exitCode,
				message: composition.ok ? playwright.message : (composition.message ?? playwright.message),
				outputTail: [playwright.outputTail, composition.outputTail].filter(Boolean).join("\n---\n"),
			};
			// Replace would double-count if we already pushed — push merged only
			if (maybeStop(push(merged))) return finish(false);
		}
	}

	// critical coverage
	{
		const t0 = Date.now();
		const r = await runCommandGate(
			"coverage",
			["bun", "run", "coverage:critical"],
			spawn,
			env,
			root,
			t0,
		);
		if (maybeStop(push(r))) return finish(false);
	}

	// production builds
	{
		const t0 = Date.now();
		const r = await runCommandGate("build", ["bun", "run", "build"], spawn, env, root, t0);
		if (maybeStop(push(r))) return finish(false);
	}

	// migrations — execute forward migrations against the qualification database
	{
		const t0 = Date.now();
		const r = await runCommandGate(
			"migrations",
			["bun", "run", "--filter", "@autopilot-console/database", "migrate"],
			spawn,
			env,
			root,
			t0,
		);
		if (maybeStop(push(r))) return finish(false);
	}

	// image — validate Dockerfiles and materialize every Compose image. Static
	// graph output is diagnostic only; a missing daemon cannot qualify a release.
	{
		const t0 = Date.now();
		const dockerfiles = ["apps/web/Dockerfile", "apps/api/Dockerfile", "apps/worker/Dockerfile"];
		const missing = dockerfiles.filter((f) => !existsSync(join(root, f)));
		if (missing.length > 0) {
			const r: GateRunResult = {
				name: "image",
				ok: false,
				durationMs: Date.now() - t0,
				exitCode: 1,
				message: `Image gate failed — missing Dockerfiles: ${missing.join(", ")}.`,
			};
			if (maybeStop(push(r))) return finish(false);
		} else {
			const cenv = composeEnv(env);
			// Bake print is daemon-independent and is the authoritative static graph check.
			const printed = await spawn(["docker", "compose", "build", "--print"], {
				cwd: root,
				env: cenv,
			});
			const printBody = combined(printed);
			const requiredTargets = ["api", "web", "worker", "migrate"];
			const missingTargets = requiredTargets.filter(
				(t) => !new RegExp(`"${t}"\\s*:`).test(printBody) && !printBody.includes(`"${t}"`),
			);
			const info = await spawn(["docker", "info"], { cwd: root, env: cenv });
			let buildOk = printed.exitCode === 0 && missingTargets.length === 0;
			let message: string | undefined;
			if (missingTargets.length > 0) {
				buildOk = false;
				message = `Image gate failed — compose build graph missing targets: ${missingTargets.join(", ")}.`;
			} else if (printed.exitCode !== 0) {
				buildOk = false;
				message = `Image gate failed — docker compose build --print exited ${printed.exitCode}: ${tail(printBody)}`;
			} else if (info.exitCode === 0) {
				// Daemon available: materialize images (also exercises --check semantics).
				const check = await spawn(["docker", "compose", "build", "--check"], {
					cwd: root,
					env: cenv,
				});
				if (check.exitCode !== 0) {
					buildOk = false;
					message = `Image gate failed — docker compose build --check exited ${check.exitCode}: ${tail(combined(check))}`;
				} else {
					const built = await spawn(["docker", "compose", "build"], { cwd: root, env: cenv });
					if (built.exitCode !== 0) {
						buildOk = false;
						message = `Image gate failed — docker compose build exited ${built.exitCode}. ${tail(combined(built))}`;
					}
				}
			} else {
				buildOk = false;
				message = `Image gate failed — Docker daemon is unavailable; every image must be materialized before Phase 1 qualification. ${tail(combined(info))}`;
			}
			const r: GateRunResult = {
				name: "image",
				ok: buildOk,
				durationMs: Date.now() - t0,
				exitCode: buildOk ? 0 : 1,
				message,
				outputTail: tail(printBody),
			};
			if (maybeStop(push(r))) return finish(false);
		}
	}

	// Compose + deployment smoke — use a unique project, empty volumes and the
	// same live health and recovery commands documented for operators.
	{
		const stack = await runComposeStackQualification(spawn, root, env);
		push(stack.compose);
		push(stack.deployment);
		if (failFast && (!stack.compose.ok || !stack.deployment.ok)) return finish(false);
	}

	// Ensure every named gate appears exactly once
	for (const name of PHASE1_GATES) {
		if (!gates.some((g) => g.name === name)) {
			gates.push({
				name,
				ok: false,
				durationMs: 0,
				exitCode: 1,
				message: `Gate "${name}" was not executed — qualification fails closed.`,
			});
		}
	}

	return finish(gates.every((g) => g.ok) && gates.length >= PHASE1_GATES.length);
}

export function formatSummary(summary: QualificationSummary): string {
	const lines: string[] = [];
	lines.push("Phase 1 Release Qualification");
	lines.push(`command: ${summary.command}`);
	lines.push(`started: ${summary.startedAt}`);
	lines.push(`finished: ${summary.finishedAt}`);
	lines.push(`durationMs: ${summary.durationMs}`);
	lines.push(`result: ${summary.ok ? "PASS" : "FAIL"}`);
	lines.push("");
	lines.push("Dependencies:");
	for (const [name, dep] of Object.entries(summary.dependencies)) {
		lines.push(`  ${dep.ok ? "✓" : "✗"} ${name}: ${dep.detail}`);
	}
	lines.push("");
	lines.push("Gates:");
	for (const gate of summary.gates) {
		const mark = gate.ok ? "✓" : "✗";
		lines.push(
			`  ${mark} ${gate.name.padEnd(18)} exit=${gate.exitCode} ${gate.durationMs}ms` +
				(gate.message ? ` — ${gate.message}` : ""),
		);
	}
	if (!summary.ok) {
		lines.push("");
		lines.push(
			"Qualification failed closed. Fix the first failing gate, then re-run: bun run verify:phase-1",
		);
	} else {
		lines.push("");
		lines.push(
			"All Phase 1 gates passed. Re-run once more to confirm consecutive success before claiming qualification.",
		);
	}
	return lines.join("\n");
}

async function main(): Promise<void> {
	const summaryPath = process.env.PHASE1_SUMMARY_PATH;
	const summary = await runPhase1Qualification({
		summaryPath,
		env: qualificationEnvironment(),
	});
	const text = formatSummary(summary);
	console.log(text);
	const jsonPath = summaryPath ?? join(ROOT, "phase-1-qualification-summary.json");
	writeFileSync(
		jsonPath,
		`${JSON.stringify(
			{
				ok: summary.ok,
				startedAt: summary.startedAt,
				finishedAt: summary.finishedAt,
				durationMs: summary.durationMs,
				command: summary.command,
				dependencies: summary.dependencies,
				gates: summary.gates.map((g) => ({
					name: g.name,
					ok: g.ok,
					exitCode: g.exitCode,
					durationMs: g.durationMs,
					message: g.message ?? null,
				})),
			},
			null,
			2,
		)}\n`,
	);
	console.log(`\nMachine-readable summary: ${jsonPath}`);
	process.exit(summary.ok ? 0 : 1);
}

const isMain = typeof Bun !== "undefined" && Bun.main && import.meta.path === Bun.main;
if (isMain) {
	main().catch((err) => {
		console.error(err);
		process.exit(2);
	});
}
