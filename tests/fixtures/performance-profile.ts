/**
 * Phase 1 supported single-server performance profile (requirement 45).
 *
 * Shared constants, seed, and measurement helpers stay separate from
 * functional suite assertions. Operators see the same profile name and
 * budgets documented in docs/deployment.md.
 */

import type { Sql } from "../../packages/database/src/index";
import { DATABASE_URL } from "./phase-1-seed";

export const PROJECT_COUNT = 10;
export const RELEASES_PER_PROJECT = 10;
export const FEATURES_PER_RELEASE = 5;
export const NON_ARCHIVED_FEATURE_COUNT =
	PROJECT_COUNT * RELEASES_PER_PROJECT * FEATURES_PER_RELEASE; // 500
export const RELEASE_COUNT = PROJECT_COUNT * RELEASES_PER_PROJECT; // 100
export const ACTIVE_JOB_COUNT = 4;
/** Archived noise that must not inflate the non-archived count. */
export const ARCHIVED_FEATURE_NOISE = 25;

export const SUPPORTED_PROFILE = {
	name: "phase-1-single-server",
	database: "PostgreSQL 16 (local Docker Compose single-server)",
	hostPattern: /127\.0\.0\.1|localhost/,
	port: 5432,
	databaseName: "autopilot_console",
} as const;

export const WARM_UP_SAMPLES = 5;
export const MEASURED_SAMPLES = 40;
export const LATENCY_BUDGET_MS = 1000;
export const REQUIRED_UNDER_BUDGET_RATIO = 0.95;
export const WARM_UP_POLICY =
	`discard first ${WARM_UP_SAMPLES} samples; measure next ${MEASURED_SAMPLES}; ` +
	`budget ${LATENCY_BUDGET_MS}ms; require under-budget ratio >= ${REQUIRED_UNDER_BUDGET_RATIO}`;

export interface Measurement {
	endpoint: string;
	latenciesMs: number[];
	warmUpCount: number;
	warmUpPolicy: string;
}

export function parseDatabaseUrl(url: string): { host: string; port: number; database: string } {
	const parsed = new URL(url);
	return {
		host: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : 5432,
		database: parsed.pathname.replace(/^\//, ""),
	};
}

export function p95(sortedAscending: number[]): number {
	if (sortedAscending.length === 0) {
		throw new Error("Cannot compute p95 of empty sample set");
	}
	const idx = Math.ceil(sortedAscending.length * 0.95) - 1;
	return sortedAscending[Math.max(0, Math.min(sortedAscending.length - 1, idx))];
}

export function summarize(measurement: Measurement): {
	p95Ms: number;
	minMs: number;
	maxMs: number;
	underBudgetCount: number;
	underBudgetRatio: number;
	databaseUrlHost: string;
} {
	const sorted = [...measurement.latenciesMs].sort((a, b) => a - b);
	const underBudgetCount = measurement.latenciesMs.filter((ms) => ms < LATENCY_BUDGET_MS).length;
	const db = parseDatabaseUrl(DATABASE_URL);
	return {
		p95Ms: p95(sorted),
		minMs: sorted[0],
		maxMs: sorted[sorted.length - 1],
		underBudgetCount,
		underBudgetRatio: underBudgetCount / measurement.latenciesMs.length,
		databaseUrlHost: `${db.host}:${db.port}/${db.database}`,
	};
}

export function formatDiagnostics(measurement: Measurement): string {
	const stats = summarize(measurement);
	return [
		`endpoint=${measurement.endpoint}`,
		`sampleCount=${measurement.latenciesMs.length}`,
		`warmUpCount=${measurement.warmUpCount}`,
		`warmUpPolicy=${measurement.warmUpPolicy}`,
		`p95Ms=${stats.p95Ms.toFixed(3)}`,
		`minMs=${stats.minMs.toFixed(3)}`,
		`maxMs=${stats.maxMs.toFixed(3)}`,
		`underBudgetCount=${stats.underBudgetCount}`,
		`underBudgetRatio=${stats.underBudgetRatio.toFixed(4)}`,
		`budgetMs=${LATENCY_BUDGET_MS}`,
		`databaseProfile=${SUPPORTED_PROFILE.name}`,
		`databaseUrlHost=${stats.databaseUrlHost}`,
		`seed.projects=${PROJECT_COUNT}`,
		`seed.releases=${RELEASE_COUNT}`,
		`seed.nonArchivedFeatures=${NON_ARCHIVED_FEATURE_COUNT}`,
		`seed.activeJobs=${ACTIVE_JOB_COUNT}`,
		`latenciesMs=[${measurement.latenciesMs.map((ms) => ms.toFixed(2)).join(", ")}]`,
	].join(" | ");
}

/**
 * Seed exact Phase 1 scale with set-based SQL plus archived noise so
 * "non-archived" is self-checked. Returns feature ids with RUNNING jobs.
 */
export async function seedPhase1PerformanceScale(
	sql: Sql,
	workspaceRoot: string,
): Promise<{ activeJobFeatureIds: string[] }> {
	const workspaces = await sql`SELECT id FROM workspaces LIMIT 1`;
	const workspaceId = workspaces[0].id as string;

	const projects = await sql`
		INSERT INTO projects (
			workspace_id, name, slug, github_owner, github_repo,
			canonical_path, development_branch, status
		)
		SELECT
			${workspaceId},
			'Perf Project ' || g,
			'perf-project-' || g,
			'acme',
			'perf-project-' || g,
			${workspaceRoot} || '/perf-project-' || g,
			'main',
			'active'
		FROM generate_series(0, ${PROJECT_COUNT - 1}) AS g
		RETURNING id, slug
	`;

	const releases = await sql`
		INSERT INTO releases (project_id, name, version, sort_order, status)
		SELECT
			p.id,
			'v' || r || '.0.0',
			r || '.0.0',
			r,
			'PLANNED'::release_status
		FROM unnest(${projects.map((p) => p.id)}::uuid[]) WITH ORDINALITY AS p(id, project_ord)
		CROSS JOIN generate_series(0, ${RELEASES_PER_PROJECT - 1}) AS r
		RETURNING id, project_id, sort_order
	`;

	await sql`
		INSERT INTO features (project_id, release_id, title, slug, state, branch_name)
		SELECT
			r.project_id,
			r.id,
			'Feature ' || r.sort_order || '-' || f,
			'feat-' || replace(r.id::text, '-', '') || '-' || f,
			(CASE WHEN f % 3 = 0 THEN 'DEVELOPMENT_MERGED' ELSE 'PLANNED' END)::feature_state,
			'feature/feat-' || replace(r.id::text, '-', '') || '-' || f
		FROM unnest(
			${releases.map((r) => r.id)}::uuid[],
			${releases.map((r) => r.project_id)}::uuid[],
			${releases.map((r) => r.sort_order)}::int[]
		) AS r(id, project_id, sort_order)
		CROSS JOIN generate_series(0, ${FEATURES_PER_RELEASE - 1}) AS f
	`;

	const firstProjectId = projects[0].id as string;
	const [firstRelease] = await sql`
		SELECT id FROM releases
		WHERE project_id = ${firstProjectId}
		ORDER BY sort_order ASC
		LIMIT 1
	`;
	await sql`
		INSERT INTO features (project_id, release_id, title, slug, state, branch_name, archived_at)
		SELECT
			${firstProjectId},
			${firstRelease.id},
			'Archived noise ' || g,
			'archived-noise-' || g,
			'PLANNED'::feature_state,
			'feature/archived-noise-' || g,
			NOW()
		FROM generate_series(0, ${ARCHIVED_FEATURE_NOISE - 1}) AS g
	`;

	const admins = await sql`SELECT id FROM admin_accounts LIMIT 1`;
	const adminId = admins[0]?.id as string | undefined;
	if (!adminId) throw new Error("No admin account found for seeding task approvals");

	const [worker] = await sql`
		INSERT INTO worker_registrations (worker_id, hostname, capacity)
		VALUES ('perf-worker-1', 'perf-host', 4)
		RETURNING id
	`;

	const jobFeatures = await sql`
		SELECT DISTINCT ON (p.id) f.id AS feature_id, p.id AS project_id
		FROM projects p
		JOIN features f ON f.project_id = p.id AND f.archived_at IS NULL
		WHERE p.slug LIKE 'perf-project-%'
		ORDER BY p.id, f.created_at ASC, f.id ASC
		LIMIT ${ACTIVE_JOB_COUNT}
	`;
	if (jobFeatures.length !== ACTIVE_JOB_COUNT) {
		throw new Error(`Expected ${ACTIVE_JOB_COUNT} job features, got ${jobFeatures.length}`);
	}

	const activeJobFeatureIds: string[] = [];
	for (let i = 0; i < jobFeatures.length; i++) {
		const row = jobFeatures[i];
		activeJobFeatureIds.push(row.feature_id as string);

		const [approval] = await sql`
			INSERT INTO task_approvals (
				project_id, feature_id, relative_task_path, checksum,
				schema_compatibility_version, requirements_snapshot, approved_by_admin_id
			)
			VALUES (
				${row.project_id},
				${row.feature_id},
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
				${row.project_id},
				${row.feature_id},
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

	return { activeJobFeatureIds };
}

export async function countPhase1PerformanceScale(sql: Sql): Promise<{
	projects: number;
	releases: number;
	nonArchivedFeatures: number;
	archivedFeatures: number;
	activeJobs: number;
}> {
	const [counts] = await sql`
		SELECT
			(SELECT COUNT(*)::int FROM projects WHERE status = 'active' AND archived_at IS NULL) AS projects,
			(SELECT COUNT(*)::int FROM releases) AS releases,
			(SELECT COUNT(*)::int FROM features WHERE archived_at IS NULL) AS non_archived_features,
			(SELECT COUNT(*)::int FROM features WHERE archived_at IS NOT NULL) AS archived_features,
			(SELECT COUNT(*)::int FROM development_job_attempts WHERE status = 'RUNNING') AS active_jobs
	`;
	return {
		projects: counts.projects as number,
		releases: counts.releases as number,
		nonArchivedFeatures: counts.non_archived_features as number,
		archivedFeatures: counts.archived_features as number,
		activeJobs: counts.active_jobs as number,
	};
}

export async function measureMs(fn: () => Promise<void>): Promise<number> {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

/**
 * Time warm GET samples. Body validation stays outside the timer so harness
 * work does not inflate p95.
 */
export async function measureWarmGet(options: {
	request: (path: string) => Promise<Response>;
	path: string;
	endpoint: string;
	assertBody: (body: unknown) => void;
}): Promise<Measurement> {
	const probe = await options.request(options.path);
	if (probe.status !== 200) {
		throw new Error(`${options.endpoint} probe returned ${probe.status}`);
	}
	options.assertBody(await probe.json());

	for (let i = 0; i < WARM_UP_SAMPLES; i++) {
		const res = await options.request(options.path);
		if (res.status !== 200) {
			throw new Error(`${options.endpoint} warm-up returned ${res.status}`);
		}
	}

	const latenciesMs: number[] = [];
	for (let i = 0; i < MEASURED_SAMPLES; i++) {
		const ms = await measureMs(async () => {
			const res = await options.request(options.path);
			if (res.status !== 200) {
				throw new Error(`${options.endpoint} returned ${res.status}`);
			}
		});
		latenciesMs.push(ms);
	}

	return {
		endpoint: options.endpoint,
		latenciesMs,
		warmUpCount: WARM_UP_SAMPLES,
		warmUpPolicy: WARM_UP_POLICY,
	};
}

export function assertMeetsBudget(measurement: Measurement): void {
	const stats = summarize(measurement);
	if (measurement.latenciesMs.length !== MEASURED_SAMPLES) {
		throw new Error(`Expected ${MEASURED_SAMPLES} samples, got ${measurement.latenciesMs.length}`);
	}
	if (measurement.warmUpCount !== WARM_UP_SAMPLES) {
		throw new Error(`Expected warm-up ${WARM_UP_SAMPLES}, got ${measurement.warmUpCount}`);
	}
	if (measurement.warmUpPolicy !== WARM_UP_POLICY) {
		throw new Error(`Unexpected warm-up policy: ${measurement.warmUpPolicy}`);
	}

	const shortSummary =
		`${measurement.endpoint} p95=${stats.p95Ms.toFixed(3)}ms ` +
		`ratio=${stats.underBudgetRatio.toFixed(4)} ` +
		`samples=${measurement.latenciesMs.length} ` +
		`profile=${SUPPORTED_PROFILE.name} host=${stats.databaseUrlHost}`;
	console.log(`[perf] ${shortSummary}`);

	if (stats.underBudgetRatio < REQUIRED_UNDER_BUDGET_RATIO || stats.p95Ms >= LATENCY_BUDGET_MS) {
		throw new Error(
			`Performance budget missed for ${measurement.endpoint}. ` +
				`Required ${REQUIRED_UNDER_BUDGET_RATIO * 100}% under ${LATENCY_BUDGET_MS}ms; ` +
				`observed ratio=${stats.underBudgetRatio.toFixed(4)}, p95=${stats.p95Ms.toFixed(3)}ms. ` +
				`Diagnostics: ${formatDiagnostics(measurement)}`,
		);
	}
}
