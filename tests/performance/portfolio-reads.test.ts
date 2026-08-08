/**
 * Portfolio read performance tests (requirement 45).
 *
 * Functional assertions only. Seed, measurement, and profile constants live
 * in tests/fixtures/performance-profile.ts so they stay separate from the
 * suite and match the operator profile in docs/deployment.md.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE_NAME } from "../../apps/api/src/auth/session-cookie";
import {
	ACTIVE_JOB_COUNT,
	ARCHIVED_FEATURE_NOISE,
	assertMeetsBudget,
	countPhase1PerformanceScale,
	LATENCY_BUDGET_MS,
	MEASURED_SAMPLES,
	type Measurement,
	measureWarmGet,
	NON_ARCHIVED_FEATURE_COUNT,
	PROJECT_COUNT,
	parseDatabaseUrl,
	RELEASE_COUNT,
	SUPPORTED_PROFILE,
	seedPhase1PerformanceScale,
	WARM_UP_POLICY,
	WARM_UP_SAMPLES,
} from "../fixtures/performance-profile";
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

async function loginApi(): Promise<string> {
	const loginResult = await ctx.api.directLogin({
		username: ADMIN_USERNAME,
		password: ADMIN_PASSWORD,
	});
	expect(loginResult.ok).toBe(true);
	if (!loginResult.ok) throw new Error("Login failed");
	return loginResult.token;
}

/** Authenticated GET without CSRF — session cookie is enough for reads. */
async function authenticatedGet(token: string, path: string): Promise<Response> {
	return ctx.api.app.request(path, {
		method: "GET",
		headers: {
			Cookie: `${SESSION_COOKIE_NAME}=${token}`,
		},
	});
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "perf-reads-"));
	ctx = await bootstrapPhase1({ workspaceRoot: tempDir });
});

afterAll(async () => {
	await ctx.client.end();
	await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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

	test("performance assertion is measurement-based, not timeout-based", () => {
		const fast: Measurement = {
			endpoint: "synthetic",
			latenciesMs: Array.from({ length: MEASURED_SAMPLES }, () => 5),
			warmUpCount: WARM_UP_SAMPLES,
			warmUpPolicy: WARM_UP_POLICY,
		};
		expect(() => assertMeetsBudget(fast)).not.toThrow();

		const slow: Measurement = {
			endpoint: "synthetic-slow",
			latenciesMs: Array.from({ length: MEASURED_SAMPLES }, () => LATENCY_BUDGET_MS + 50),
			warmUpCount: WARM_UP_SAMPLES,
			warmUpPolicy: WARM_UP_POLICY,
		};
		expect(() => assertMeetsBudget(slow)).toThrow(
			/Performance budget missed.*Diagnostics:.*p95Ms=/,
		);
	});

	describe("seeded scale measurements", () => {
		// Single truncate/bootstrap for the measurement suite — not per test.
		beforeAll(async () => {
			await truncateAll(ctx.sql);
			await ctx.api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
		});

		test("exact seed scale and warm Overview + feature-detail reads meet 95% under 1s", async () => {
			const seeded = await seedPhase1PerformanceScale(ctx.sql, tempDir);
			const counts = await countPhase1PerformanceScale(ctx.sql);

			expect(counts.projects).toBe(PROJECT_COUNT);
			expect(counts.releases).toBe(RELEASE_COUNT);
			expect(counts.nonArchivedFeatures).toBe(NON_ARCHIVED_FEATURE_COUNT);
			expect(counts.archivedFeatures).toBe(ARCHIVED_FEATURE_NOISE);
			expect(counts.activeJobs).toBe(ACTIVE_JOB_COUNT);
			expect(seeded.activeJobFeatureIds).toHaveLength(ACTIVE_JOB_COUNT);

			const token = await loginApi();
			const featureId = seeded.activeJobFeatureIds[0];
			const request = (path: string) => authenticatedGet(token, path);

			const overview = await measureWarmGet({
				request,
				path: "/api/overview",
				endpoint: "GET /api/overview",
				assertBody: (raw) => {
					const body = raw as {
						ok: boolean;
						data: { projectCount: number; activeJobs: number };
					};
					expect(body.ok).toBe(true);
					expect(body.data.projectCount).toBe(PROJECT_COUNT);
					expect(body.data.activeJobs).toBe(ACTIVE_JOB_COUNT);
				},
			});

			const detail = await measureWarmGet({
				request,
				path: `/api/features/${featureId}`,
				endpoint: `GET /api/features/${featureId}`,
				assertBody: (raw) => {
					const body = raw as {
						ok: boolean;
						data: { id: string; activeAttempt: { status: string } | null };
					};
					expect(body.ok).toBe(true);
					expect(body.data.id).toBe(featureId);
					expect(body.data.activeAttempt?.status).toBe("RUNNING");
				},
			});

			assertMeetsBudget(overview);
			assertMeetsBudget(detail);
		}, 120_000);
	});
});
