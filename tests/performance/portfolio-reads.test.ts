/**
 * Portfolio read performance tests (requirement 45).
 *
 * Self-validating proof that authenticated Overview and feature-detail reads
 * meet the Phase 1 latency contract against real PostgreSQL at the documented
 * seed scale on the supported single-server profile.
 *
 * The performance gate is the measured sample ratio / p95 — never the Bun
 * test timeout. Timeouts only bound seed + measurement wall-clock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../../packages/database/src/index";
import {
	ADMIN_PASSWORD,
	ADMIN_USERNAME,
	bootstrapPhase1,
	DATABASE_URL,
	type Phase1Context,
	truncateAll,
} from "../fixtures/phase-1-seed";

let ctx: Phase1Context;
let tempDir: string;

/** Exact Phase 1 scale from the PRD / acceptance criteria. */
const PROJECT_COUNT = 10;
const RELEASES_PER_PROJECT = 10;
const FEATURES_PER_RELEASE = 5;
const NON_ARCHIVED_FEATURE_COUNT = PROJECT_COUNT * RELEASES_PER_PROJECT * FEATURES_PER_RELEASE; // 500
const RELEASE_COUNT = PROJECT_COUNT * RELEASES_PER_PROJECT; // 100
const ACTIVE_JOB_COUNT = 4;
/** Archived noise that must not inflate the non-archived count. */
const ARCHIVED_FEATURE_NOISE = 25;

/**
 * Documented supported single-server performance profile.
 * Must match the section in docs/deployment.md so operators and the suite
 * share one source of truth.
 */
const SUPPORTED_PROFILE = {
	name: "phase-1-single-server",
	database: "PostgreSQL 16 (local Docker Compose single-server)",
	hostPattern: /127\.0\.0\.1|localhost/,
	port: 5432,
	databaseName: "autopilot_console",
	description:
		"Single-server Docker Compose stack: API + worker + PostgreSQL on one host. Performance acceptance is measured against this profile with warm reads after discardable warm-up samples.",
};

const WARM_UP_SAMPLES = 5;
const MEASURED_SAMPLES = 40;
const LATENCY_BUDGET_MS = 1000;
const REQUIRED_UNDER_BUDGET_RATIO = 0.95;

export interface EndpointPerformanceReport {
	endpoint: string;
	sampleCount: number;
	warmUpCount: number;
	warmUpPolicy: string;
	latenciesMs: number[];
	p95Ms: number;
	minMs: number;
	maxMs: number;
	underBudgetCount: number;
	underBudgetRatio: number;
	budgetMs: number;
	databaseProfile: typeof SUPPORTED_PROFILE & { databaseUrlHost: string };
	seed: {
		projects: number;
		releases: number;
		nonArchivedFeatures: number;
		activeJobs: number;
		archivedFeatureNoise: number;
	};
	failureDiagnostics: string;
}

function parseDatabaseUrl(url: string): { host: string; port: number; database: string } {
	const parsed = new URL(url);
	return {
		host: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : 5432,
		database: parsed.pathname.replace(/^\//, ""),
	};
}

function percentile(sortedAscending: number[], ratio: number): number {
	if (sortedAscending.length === 0) {
		throw new Error("Cannot compute percentile of empty sample set");
	}
	const idx = Math.ceil(sortedAscending.length * ratio) - 1;
	return sortedAscending[Math.max(0, Math.min(sortedAscending.length - 1, idx))];
}

function p95(sortedAscending: number[]): number {
	return percentile(sortedAscending, 0.95);
}

async function loginApi(): Promise<string> {
	const loginResult = await ctx.api.directLogin({
		username: ADMIN_USERNAME,
		password: ADMIN_PASSWORD,
	});
	expect(loginResult.ok).toBe(true);
	if (!loginResult.ok) throw new Error("Login failed");
	return loginResult.token;
}

async function apiCall(token: string, method: string, path: string): Promise<Response> {
	const csrf = await ctx.api.issueCsrf(token);
	return ctx.api.app.request(path, {
		method,
		headers: {
			Cookie: `ac_session=${token}`,
			"x-csrf-token": csrf,
		},
	});
}

async function measureMs(fn: () => Promise<void>): Promise<number> {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

/**
 * Seed exact Phase 1 scale plus archived noise so "non-archived" is self-checked.
 * Returns feature ids that have active RUNNING jobs (first ACTIVE_JOB_COUNT projects).
 */
async function seedScaleFixtures(sql: Sql): Promise<{
	featureIds: string[];
	activeJobFeatureIds: string[];
}> {
	const featureIds: string[] = [];
	const projectIds: string[] = [];
	const activeJobFeatureIds: string[] = [];

	const workspaces = await sql`SELECT id FROM workspaces LIMIT 1`;
	const workspaceId = workspaces[0].id;

	for (let p = 0; p < PROJECT_COUNT; p++) {
		const slug = `perf-project-${p}`;
		const [project] = await sql`
			INSERT INTO projects (workspace_id, name, slug, github_owner, github_repo, canonical_path, development_branch, status)
			VALUES (${workspaceId}, ${`Perf Project ${p}`}, ${slug}, 'acme', ${slug}, ${join(tempDir, slug)}, 'main', 'active')
			RETURNING id
		`;
		projectIds.push(project.id);

		for (let r = 0; r < RELEASES_PER_PROJECT; r++) {
			const [release] = await sql`
				INSERT INTO releases (project_id, name, version, sort_order, status)
				VALUES (${project.id}, ${`v${r}.0.0`}, ${`${r}.0.0`}, ${r}, 'PLANNED')
				RETURNING id
			`;

			for (let f = 0; f < FEATURES_PER_RELEASE; f++) {
				const featSlug = `feat-${p}-${r}-${f}`;
				const [feature] = await sql`
					INSERT INTO features (project_id, release_id, title, slug, state, branch_name)
					VALUES (
						${project.id},
						${release.id},
						${`Feature ${p}-${r}-${f}`},
						${featSlug},
						${f % 3 === 0 ? "DEVELOPMENT_MERGED" : "PLANNED"},
						${`feature/${featSlug}`}
					)
					RETURNING id
				`;
				featureIds.push(feature.id);
			}
		}
	}

	// Archived noise reuses an existing release so release cardinality stays exact (100).
	// These rows must not count toward the 500 non-archived features.
	const noiseProjectId = projectIds[0];
	const [existingRelease] = await sql`
		SELECT id FROM releases WHERE project_id = ${noiseProjectId} ORDER BY sort_order ASC LIMIT 1
	`;
	for (let i = 0; i < ARCHIVED_FEATURE_NOISE; i++) {
		await sql`
			INSERT INTO features (project_id, release_id, title, slug, state, branch_name, archived_at)
			VALUES (
				${noiseProjectId},
				${existingRelease.id},
				${`Archived noise ${i}`},
				${`archived-noise-${i}`},
				'PLANNED',
				${`feature/archived-noise-${i}`},
				NOW()
			)
		`;
	}

	const admins = await sql`SELECT id FROM admin_accounts LIMIT 1`;
	const adminId = admins[0]?.id;
	if (!adminId) throw new Error("No admin account found for seeding task approvals");

	const [worker] = await sql`
		INSERT INTO worker_registrations (worker_id, hostname, capacity)
		VALUES ('perf-worker-1', 'perf-host', 4)
		RETURNING id
	`;

	for (let i = 0; i < ACTIVE_JOB_COUNT; i++) {
		const projectId = projectIds[i];
		const featureId = featureIds[i * RELEASES_PER_PROJECT * FEATURES_PER_RELEASE];
		activeJobFeatureIds.push(featureId);

		const [approval] = await sql`
			INSERT INTO task_approvals (project_id, feature_id, relative_task_path, checksum, schema_compatibility_version, requirements_snapshot, approved_by_admin_id)
			VALUES (
				${projectId},
				${featureId},
				'tasks/perf.json',
				${`checksum-${i}`},
				'1.0',
				${sql.json([])},
				${adminId}
			)
			RETURNING id
		`;

		await sql`
			INSERT INTO development_job_attempts (
				project_id, feature_id, task_approval_id, branch_name,
				operation_key, status, worker_registration_id,
				process_pid, started_at
			) VALUES (
				${projectId},
				${featureId},
				${approval.id},
				'feature/perf-active',
				${`perf-active-${i}`},
				'RUNNING',
				${worker.id},
				${1000 + i},
				NOW()
			)
		`;
	}

	return { featureIds, activeJobFeatureIds };
}

async function assertExactSeedCardinality(sql: Sql): Promise<void> {
	const projectCount = await sql`
		SELECT COUNT(*)::int AS count FROM projects WHERE status = 'active' AND archived_at IS NULL
	`;
	const releaseCount = await sql`SELECT COUNT(*)::int AS count FROM releases`;
	const nonArchivedFeatures = await sql`
		SELECT COUNT(*)::int AS count FROM features WHERE archived_at IS NULL
	`;
	const archivedFeatures = await sql`
		SELECT COUNT(*)::int AS count FROM features WHERE archived_at IS NOT NULL
	`;
	const activeJobs = await sql`
		SELECT COUNT(*)::int AS count FROM development_job_attempts WHERE status = 'RUNNING'
	`;

	expect(projectCount[0].count).toBe(PROJECT_COUNT);
	expect(releaseCount[0].count).toBe(RELEASE_COUNT);
	expect(nonArchivedFeatures[0].count).toBe(NON_ARCHIVED_FEATURE_COUNT);
	expect(archivedFeatures[0].count).toBe(ARCHIVED_FEATURE_NOISE);
	expect(activeJobs[0].count).toBe(ACTIVE_JOB_COUNT);
}

function buildReport(input: {
	endpoint: string;
	latenciesMs: number[];
	warmUpCount: number;
	warmUpPolicy: string;
}): EndpointPerformanceReport {
	const sorted = [...input.latenciesMs].sort((a, b) => a - b);
	const underBudgetCount = input.latenciesMs.filter((ms) => ms < LATENCY_BUDGET_MS).length;
	const underBudgetRatio = underBudgetCount / input.latenciesMs.length;
	const db = parseDatabaseUrl(DATABASE_URL);
	const p95Ms = p95(sorted);
	const minMs = sorted[0];
	const maxMs = sorted[sorted.length - 1];

	const report: EndpointPerformanceReport = {
		endpoint: input.endpoint,
		sampleCount: input.latenciesMs.length,
		warmUpCount: input.warmUpCount,
		warmUpPolicy: input.warmUpPolicy,
		latenciesMs: input.latenciesMs,
		p95Ms,
		minMs,
		maxMs,
		underBudgetCount,
		underBudgetRatio,
		budgetMs: LATENCY_BUDGET_MS,
		databaseProfile: {
			...SUPPORTED_PROFILE,
			databaseUrlHost: `${db.host}:${db.port}/${db.database}`,
		},
		seed: {
			projects: PROJECT_COUNT,
			releases: RELEASE_COUNT,
			nonArchivedFeatures: NON_ARCHIVED_FEATURE_COUNT,
			activeJobs: ACTIVE_JOB_COUNT,
			archivedFeatureNoise: ARCHIVED_FEATURE_NOISE,
		},
		failureDiagnostics: "",
	};

	report.failureDiagnostics = [
		`endpoint=${report.endpoint}`,
		`sampleCount=${report.sampleCount}`,
		`warmUpCount=${report.warmUpCount}`,
		`warmUpPolicy=${report.warmUpPolicy}`,
		`p95Ms=${report.p95Ms.toFixed(3)}`,
		`minMs=${report.minMs.toFixed(3)}`,
		`maxMs=${report.maxMs.toFixed(3)}`,
		`underBudgetCount=${report.underBudgetCount}`,
		`underBudgetRatio=${report.underBudgetRatio.toFixed(4)}`,
		`budgetMs=${report.budgetMs}`,
		`databaseProfile=${report.databaseProfile.name}`,
		`databaseUrlHost=${report.databaseProfile.databaseUrlHost}`,
		`seed.projects=${report.seed.projects}`,
		`seed.releases=${report.seed.releases}`,
		`seed.nonArchivedFeatures=${report.seed.nonArchivedFeatures}`,
		`seed.activeJobs=${report.seed.activeJobs}`,
		`latenciesMs=[${report.latenciesMs.map((ms) => ms.toFixed(2)).join(", ")}]`,
	].join(" | ");

	return report;
}

async function measureEndpoint(options: {
	token: string;
	method: string;
	path: string;
	endpoint: string;
	assertResponse: (res: Response) => Promise<void>;
}): Promise<EndpointPerformanceReport> {
	const warmUpPolicy = `discard first ${WARM_UP_SAMPLES} samples; measure next ${MEASURED_SAMPLES}; budget ${LATENCY_BUDGET_MS}ms; require under-budget ratio >= ${REQUIRED_UNDER_BUDGET_RATIO}`;

	for (let i = 0; i < WARM_UP_SAMPLES; i++) {
		const res = await apiCall(options.token, options.method, options.path);
		await options.assertResponse(res);
	}

	const latenciesMs: number[] = [];
	for (let i = 0; i < MEASURED_SAMPLES; i++) {
		const ms = await measureMs(async () => {
			const res = await apiCall(options.token, options.method, options.path);
			await options.assertResponse(res);
		});
		latenciesMs.push(ms);
	}

	return buildReport({
		endpoint: options.endpoint,
		latenciesMs,
		warmUpCount: WARM_UP_SAMPLES,
		warmUpPolicy,
	});
}

function assertMeetsBudget(report: EndpointPerformanceReport): void {
	// Explicit ratio and p95 — not the test timeout.
	expect(report.sampleCount).toBe(MEASURED_SAMPLES);
	expect(report.warmUpCount).toBe(WARM_UP_SAMPLES);
	expect(report.warmUpPolicy.length).toBeGreaterThan(0);
	expect(report.databaseProfile.name).toBe(SUPPORTED_PROFILE.name);
	expect(report.failureDiagnostics).toContain("p95Ms=");
	expect(report.failureDiagnostics).toContain("sampleCount=");
	expect(report.failureDiagnostics).toContain("warmUpPolicy=");
	expect(report.failureDiagnostics).toContain("databaseProfile=");

	if (report.underBudgetRatio < REQUIRED_UNDER_BUDGET_RATIO) {
		throw new Error(
			`Performance budget missed for ${report.endpoint}. ` +
				`Required ${REQUIRED_UNDER_BUDGET_RATIO * 100}% under ${LATENCY_BUDGET_MS}ms; ` +
				`observed ratio=${report.underBudgetRatio.toFixed(4)}, p95=${report.p95Ms.toFixed(3)}ms. ` +
				`Diagnostics: ${report.failureDiagnostics}`,
		);
	}

	expect(report.underBudgetRatio).toBeGreaterThanOrEqual(REQUIRED_UNDER_BUDGET_RATIO);
	expect(report.p95Ms).toBeLessThan(LATENCY_BUDGET_MS);
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "perf-reads-"));
	ctx = await bootstrapPhase1({ workspaceRoot: tempDir });
});

afterAll(async () => {
	await ctx.client.end();
	await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	await truncateAll(ctx.sql);
	await ctx.api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
});

describe("portfolio read performance (req 45)", () => {
	test("documents the supported single-server performance profile", async () => {
		const deployment = await readFile(join(import.meta.dir, "../../docs/deployment.md"), "utf8");

		expect(deployment).toContain("## Supported single-server performance profile");
		expect(deployment).toContain(SUPPORTED_PROFILE.name);
		expect(deployment).toContain("10 projects");
		expect(deployment).toContain("100 releases");
		expect(deployment).toContain("500 non-archived features");
		expect(deployment).toContain("four active jobs");
		expect(deployment).toContain("warm-up");
		expect(deployment).toContain("p95");
		expect(deployment).toContain("1 second");

		const db = parseDatabaseUrl(DATABASE_URL);
		expect(SUPPORTED_PROFILE.hostPattern.test(db.host)).toBe(true);
		expect(db.port).toBe(SUPPORTED_PROFILE.port);
		expect(db.database).toBe(SUPPORTED_PROFILE.databaseName);
	});

	test("fixture contains exact Phase 1 scale before any timing measurement", async () => {
		await seedScaleFixtures(ctx.sql);
		await assertExactSeedCardinality(ctx.sql);
	});

	test("authenticated Overview reads meet 95% under 1s with recorded diagnostics", async () => {
		const seeded = await seedScaleFixtures(ctx.sql);
		await assertExactSeedCardinality(ctx.sql);
		expect(seeded.activeJobFeatureIds).toHaveLength(ACTIVE_JOB_COUNT);

		const token = await loginApi();
		const report = await measureEndpoint({
			token,
			method: "GET",
			path: "/api/overview",
			endpoint: "GET /api/overview",
			assertResponse: async (res) => {
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					ok: boolean;
					data: { projectCount: number; activeJobs: number };
				};
				expect(body.ok).toBe(true);
				expect(body.data.projectCount).toBe(PROJECT_COUNT);
				expect(body.data.activeJobs).toBe(ACTIVE_JOB_COUNT);
			},
		});

		// Report surface required by acceptance — present even on success.
		expect(report.sampleCount).toBe(MEASURED_SAMPLES);
		expect(report.warmUpCount).toBe(WARM_UP_SAMPLES);
		expect(report.p95Ms).toBeGreaterThan(0);
		expect(report.failureDiagnostics).toContain("GET /api/overview");
		console.log(`[perf] overview report: ${report.failureDiagnostics}`);

		assertMeetsBudget(report);
	}, 120_000);

	test("authenticated feature-detail reads meet 95% under 1s with recorded diagnostics", async () => {
		const seeded = await seedScaleFixtures(ctx.sql);
		await assertExactSeedCardinality(ctx.sql);

		const featureId = seeded.activeJobFeatureIds[0];
		expect(featureId).toBeTruthy();

		const token = await loginApi();
		const report = await measureEndpoint({
			token,
			method: "GET",
			path: `/api/features/${featureId}`,
			endpoint: `GET /api/features/${featureId}`,
			assertResponse: async (res) => {
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					ok: boolean;
					data: { id: string; activeAttempt: { status: string } | null };
				};
				expect(body.ok).toBe(true);
				expect(body.data.id).toBe(featureId);
				expect(body.data.activeAttempt?.status).toBe("RUNNING");
			},
		});

		expect(report.sampleCount).toBe(MEASURED_SAMPLES);
		expect(report.warmUpCount).toBe(WARM_UP_SAMPLES);
		expect(report.failureDiagnostics).toContain("sampleCount=");
		expect(report.failureDiagnostics).toContain("databaseProfile=");
		console.log(`[perf] feature-detail report: ${report.failureDiagnostics}`);

		assertMeetsBudget(report);
	}, 120_000);

	test("performance assertion is measurement-based, not timeout-based", () => {
		// Guard against regressing to "pass if the test finishes before timeout".
		// The gate is underBudgetRatio / p95 on measured samples only.
		const syntheticFast = buildReport({
			endpoint: "synthetic",
			latenciesMs: Array.from({ length: MEASURED_SAMPLES }, () => 5),
			warmUpCount: WARM_UP_SAMPLES,
			warmUpPolicy: "synthetic",
		});
		expect(() => assertMeetsBudget(syntheticFast)).not.toThrow();

		const syntheticSlow = buildReport({
			endpoint: "synthetic-slow",
			latenciesMs: Array.from({ length: MEASURED_SAMPLES }, () => LATENCY_BUDGET_MS + 50),
			warmUpCount: WARM_UP_SAMPLES,
			warmUpPolicy: "synthetic",
		});
		expect(() => assertMeetsBudget(syntheticSlow)).toThrow(/Performance budget missed/);
		expect(() => assertMeetsBudget(syntheticSlow)).toThrow(/Diagnostics:/);
		expect(() => assertMeetsBudget(syntheticSlow)).toThrow(/p95Ms=/);
	});
});
