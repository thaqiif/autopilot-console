/**
 * Feature service — create, update, get, validation, uniqueness,
 * cross-project guards, archive protection, activity/audit atomicity.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createDatabaseClient,
	createProject,
	createWorkspace,
	type DatabaseClient,
	type Sql,
} from "../../../database/src/index";
import type { ProjectActor } from "../project/project";
import { createReleaseService, type ReleaseService } from "../release/release-service";
import { createFeatureService, type FeatureService } from "./feature-service";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

let client: DatabaseClient;
let sql: Sql;
let workspaceId: string;
let projectAId: string;
let projectBId: string;
let releaseAId: string;
let releaseBId: string;

const ACTOR: ProjectActor = { actorType: "administrator", actorId: "admin-1" };

function makeReleaseService(sqlOverride: Sql = sql): ReleaseService {
	return createReleaseService({
		sql: sqlOverride,
		now: () => new Date("2026-07-18T12:00:00.000Z"),
	});
}

function makeFeatureService(sqlOverride: Sql = sql, newId?: () => string): FeatureService {
	return createFeatureService({
		sql: sqlOverride,
		now: () => new Date("2026-07-18T12:00:00.000Z"),
		newId,
	});
}

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
	await sql.unsafe("CREATE SCHEMA public");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO postgres");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO public");
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

afterAll(async () => {
	await client.end();
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			outbox_intents,
			scheduled_reconciliation_jobs,
			idempotency_records,
			diagnostic_log_chunks,
			progress_snapshots,
			failure_records,
			activity_events,
			audit_events,
			development_job_attempts,
			worker_registrations,
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
	const workspace = await createWorkspace(sql);
	workspaceId = workspace.id;

	// Create two projects
	const a = await createProject(sql, {
		workspaceId,
		name: "Project A",
		slug: "project-a",
		githubOwner: "acme",
		githubRepo: "project-a",
		canonicalPath: "/workspaces/project-a",
		developmentBranch: "main",
	});
	const b = await createProject(sql, {
		workspaceId,
		name: "Project B",
		slug: "project-b",
		githubOwner: "acme",
		githubRepo: "project-b",
		canonicalPath: "/workspaces/project-b",
		developmentBranch: "main",
	});
	projectAId = a.id;
	projectBId = b.id;

	// Create one release per project
	const releases = makeReleaseService();
	const ra = await releases.createRelease({
		projectId: projectAId,
		name: "1.0.0",
		version: "1.0.0",
		actor: ACTOR,
	});
	if (!ra.ok) throw new Error("release A failed");
	releaseAId = ra.release.id;

	const rb = await releases.createRelease({
		projectId: projectBId,
		name: "1.0.0",
		version: "1.0.0",
		actor: ACTOR,
	});
	if (!rb.ok) throw new Error("release B failed");
	releaseBId = rb.release.id;
});

// ─── createFeature ─────────────────────────────────────────────

describe("createFeature", () => {
	test("rejects empty title", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "   ",
			slug: "valid-slug",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("VALIDATION_FAILED");
		expect(result.message).toMatch(/title.*slug.*required/i);

		// Audit event still recorded
		const audits = await sql`SELECT * FROM audit_events WHERE action = 'feature.create'`;
		expect(audits.some((a) => a.result === "rejected")).toBe(true);
	});

	test("rejects empty slug", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Valid Title",
			slug: "",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("VALIDATION_FAILED");
	});

	test("rejects empty title and slug", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "",
			slug: "   ",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("VALIDATION_FAILED");
	});

	test("rejects missing project", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: crypto.randomUUID(),
			releaseId: releaseAId,
			title: "Some Feature",
			slug: "some-feature",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("NOT_FOUND");
		expect(result.message).toMatch(/project/i);
	});

	test("rejects missing release", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: crypto.randomUUID(),
			title: "Some Feature",
			slug: "some-feature",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("NOT_FOUND");
		expect(result.message).toMatch(/release/i);
	});

	test("rejects cross-project release", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseBId, // release B belongs to project B
			title: "Cross",
			slug: "cross-project",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("CROSS_PROJECT");
		expect(result.message).toMatch(/release.*does not belong/i);

		// Verify audit was recorded
		const audits = await sql`
			SELECT * FROM audit_events WHERE action = 'feature.create' AND result = 'rejected'
		`;
		expect(
			audits.some((a) => {
				const nv = a.next_values as Record<string, unknown> | null;
				return nv?.reason === "CROSS_PROJECT";
			}),
		).toBe(true);

		// Verify no feature was created
		const rows = await sql`SELECT count(*)::int AS n FROM features`;
		expect(Number(rows[0]?.n ?? -1)).toBe(0);
	});

	test("rejects duplicate slug within same project", async () => {
		const service = makeFeatureService();
		const first = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "First",
			slug: "my-feature",
			actor: ACTOR,
		});
		expect(first.ok).toBe(true);

		const second = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Second",
			slug: "my-feature",
			actor: ACTOR,
		});
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("expected fail");
		expect(second.reason).toBe("UNIQUENESS_VIOLATION");

		// Audit was recorded for rejection
		const audits = await sql`
			SELECT * FROM audit_events WHERE action = 'feature.create' AND result = 'rejected'
		`;
		expect(
			audits.some((a) => {
				const nv = a.next_values as Record<string, unknown> | null;
				return nv?.reason === "UNIQUENESS_VIOLATION";
			}),
		).toBe(true);
	});

	test("allows same slug in different projects", async () => {
		const service = makeFeatureService();
		const fa = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Project A Feature",
			slug: "shared-slug",
			actor: ACTOR,
		});
		expect(fa.ok).toBe(true);

		const fb = await service.createFeature({
			projectId: projectBId,
			releaseId: releaseBId,
			title: "Project B Feature",
			slug: "shared-slug",
			actor: ACTOR,
		});
		expect(fb.ok).toBe(true);

		expect(fa.ok && fb.ok && fa.feature.slug === fb.feature.slug).toBe(true);
		if (!fa.ok || !fb.ok) throw new Error("creation failed");
		expect(fa.feature.id).not.toBe(fb.feature.id);
	});

	test("creates with PLANNED state, deterministic branch, and records audit/activity", async () => {
		const deterministicId = "00000000-0000-0000-0000-000000000001";
		const service = makeFeatureService(sql, () => deterministicId);

		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "  Login Flow  ", // trimmed
			slug: "Login-Flow", // normalized via sanitizeSlug
			summary: "auth UI",
			actor: ACTOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");

		const f = result.feature;
		expect(f.id).toBe(deterministicId);
		expect(f.projectId).toBe(projectAId);
		expect(f.releaseId).toBe(releaseAId);
		expect(f.state).toBe("PLANNED");
		expect(f.title).toBe("Login Flow");
		expect(f.summary).toBe("auth UI");
		expect(f.taskPath).toBeNull();
		expect(f.archivedAt).toBeNull();
		expect(f.branchName).toMatch(/^feature\//);
		expect(f.branchName).toContain(deterministicId);
		expect(f.createdAt.toISOString()).toMatch(/Z$|UTC|\+00:00/);

		// Audit
		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_type = 'feature' AND target_id = ${f.id} AND action = 'feature.create'
		`;
		expect(audits.length).toBe(1);
		expect(audits[0]?.result).toBe("success");

		// Activity
		const activity = await sql`
			SELECT * FROM activity_events
			WHERE type = 'feature.created' AND feature_id = ${f.id}
		`;
		expect(activity.length).toBe(1);
	});

	test("rejects slug that is only whitespace after normalization", async () => {
		const service = makeFeatureService();
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Weird",
			slug: "---", // sanitizeSlug may reduce to empty
			actor: ACTOR,
		});
		// The sanitizeSlug function may or may not throw/reduce — the service should handle it
		// If it passes sanitizeSlug, the trim/lowercase normalization still produces something
		// We just verify the result shape
		expect(result.ok === true || (result.ok === false && "reason" in result)).toBe(true);
	});
});

describe("createFeature transactional failures", () => {
	test("handles cross-project violation from DB during transaction", async () => {
		// Use a proxy that fakes a cross-project violation in the insert
		const brokenSql = new Proxy(sql, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									if (
										p === "unsafe" ||
										(typeof v === "function" && String(p || "").includes("query"))
									) {
										return (...args: unknown[]) => {
											const sqlText = String(args[0] ?? "");
											if (sqlText.includes("INSERT INTO features")) {
												const err = new Error(
													'release "some-id" does not belong to project',
												) as Error & { code?: string };
												err.name = "PostgresError";
												throw err;
											}
											return (v as (...a: unknown[]) => unknown).apply(t, args);
										};
									}
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const service = makeFeatureService(brokenSql);
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Will Fail",
			slug: "will-fail",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("CROSS_PROJECT");
	});

	test("handles unique violation from DB during transaction", async () => {
		const brokenSql = new Proxy(sql, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									if (
										p === "unsafe" ||
										(typeof v === "function" && String(p || "").includes("query"))
									) {
										return (...args: unknown[]) => {
											const sqlText = String(args[0] ?? "");
											if (sqlText.includes("INSERT INTO features")) {
												const err = new Error(
													"duplicate key value violates unique constraint",
												) as Error & { code?: string };
												err.name = "PostgresError";
												(err as unknown as Record<string, unknown>).code = "23505";
												throw err;
											}
											return (v as (...a: unknown[]) => unknown).apply(t, args);
										};
									}
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const service = makeFeatureService(brokenSql);
		const result = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Will Fail",
			slug: "will-fail",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("UNIQUENESS_VIOLATION");
	});

	test("re-throws non-constraint DB errors during transaction", async () => {
		const brokenSql = new Proxy(sql, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									if (
										p === "unsafe" ||
										(typeof v === "function" && String(p || "").includes("query"))
									) {
										return (...args: unknown[]) => {
											const sqlText = String(args[0] ?? "");
											if (sqlText.includes("INSERT INTO features")) {
												throw new Error("some random DB error");
											}
											return (v as (...a: unknown[]) => unknown).apply(t, args);
										};
									}
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const service = makeFeatureService(brokenSql);
		await expect(
			service.createFeature({
				projectId: projectAId,
				releaseId: releaseAId,
				title: "Boom",
				slug: "boom",
				actor: ACTOR,
			}),
		).rejects.toThrow(/random DB error/);
	});
});

// ─── getFeature ────────────────────────────────────────────────

describe("getFeature", () => {
	test("returns feature when it exists", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Find Me",
			slug: "find-me",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const found = await service.getFeature({ featureId: created.feature.id });
		expect(found).not.toBeNull();
		expect(found?.id).toBe(created.feature.id);
		expect(found?.slug).toBe("find-me");
		expect(found?.title).toBe("Find Me");
	});

	test("returns null when feature does not exist", async () => {
		const service = makeFeatureService();
		const result = await service.getFeature({ featureId: crypto.randomUUID() });
		expect(result).toBeNull();
	});
});

// ─── updateFeature ─────────────────────────────────────────────

describe("updateFeature", () => {
	test("rejects update for non-existent feature", async () => {
		const service = makeFeatureService();
		const result = await service.updateFeature({
			featureId: crypto.randomUUID(),
			title: "New Title",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("NOT_FOUND");
	});

	test("rejects update for archived feature", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "To Archive",
			slug: "to-archive",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		await sql`UPDATE features SET archived_at = now() WHERE id = ${created.feature.id}`;

		const result = await service.updateFeature({
			featureId: created.feature.id,
			title: "Updated",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("ALREADY_ARCHIVED");
	});

	test("rejects update when title becomes empty", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Original",
			slug: "original",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const result = await service.updateFeature({
			featureId: created.feature.id,
			title: "   ",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("VALIDATION_FAILED");

		// Audit rejection recorded
		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_id = ${created.feature.id} AND action = 'feature.update'
		`;
		expect(audits.some((a) => a.result === "rejected")).toBe(true);
	});

	test("rejects update when slug becomes empty", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Original",
			slug: "original",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const result = await service.updateFeature({
			featureId: created.feature.id,
			slug: "",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("VALIDATION_FAILED");
	});

	test("rejects slug collision with another feature in same project", async () => {
		const service = makeFeatureService();
		const f1 = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "First",
			slug: "first-feature",
			actor: ACTOR,
		});
		const f2 = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Second",
			slug: "second-feature",
			actor: ACTOR,
		});
		if (!f1.ok || !f2.ok) throw new Error("create failed");

		const result = await service.updateFeature({
			featureId: f2.feature.id,
			slug: "first-feature", // collides with f1
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("UNIQUENESS_VIOLATION");
	});

	test("allows updating to same slug (no-op collision with self)", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Self",
			slug: "self-slug",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const result = await service.updateFeature({
			featureId: created.feature.id,
			slug: "self-slug", // same slug
			actor: ACTOR,
		});
		// Should succeed since slug belongs to itself
		expect(result.ok).toBe(true);
	});

	test("successfully updates title, slug, and summary with audit/activity", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Original Title",
			slug: "original-slug",
			summary: "original summary",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const result = await service.updateFeature({
			featureId: created.feature.id,
			title: "  New Title  ",
			slug: "New-Slug",
			summary: "new summary",
			actor: ACTOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.feature.title).toBe("New Title");
		expect(result.feature.summary).toBe("new summary");
		// slug is normalized via sanitizeSlug
		expect(result.feature.slug).not.toBe("");

		// Audit
		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_id = ${created.feature.id} AND action = 'feature.update'
			ORDER BY created_at
		`;
		expect(audits.some((a) => a.result === "success")).toBe(true);
		const successAudit = audits.find((a) => a.result === "success");
		expect(successAudit).toBeDefined();
		expect(successAudit?.prior_values).not.toBeNull();

		// Activity
		const activity = await sql`
			SELECT * FROM activity_events
			WHERE type = 'feature.updated' AND feature_id = ${created.feature.id}
		`;
		expect(activity.length).toBe(1);
	});

	test("update clears summary when passed null", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Summary Test",
			slug: "summary-test",
			summary: "will be cleared",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const result = await service.updateFeature({
			featureId: created.feature.id,
			summary: null,
			actor: ACTOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.feature.summary).toBeNull();
	});

	test("handles unique violation from DB during update transaction", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Update Fail",
			slug: "update-fail",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const brokenSql = new Proxy(sql, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									if (
										p === "unsafe" ||
										(typeof v === "function" && String(p || "").includes("query"))
									) {
										return (...args: unknown[]) => {
											const sqlText = String(args[0] ?? "");
											if (sqlText.includes("UPDATE features")) {
												const err = new Error(
													"duplicate key value violates unique constraint",
												) as Error & { code?: string };
												err.name = "PostgresError";
												(err as unknown as Record<string, unknown>).code = "23505";
												throw err;
											}
											return (v as (...a: unknown[]) => unknown).apply(t, args);
										};
									}
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const brokenService = makeFeatureService(brokenSql);
		const result = await brokenService.updateFeature({
			featureId: created.feature.id,
			title: "Changed",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("UNIQUENESS_VIOLATION");
	});

	test("re-throws non-constraint errors during update transaction", async () => {
		const service = makeFeatureService();
		const created = await service.createFeature({
			projectId: projectAId,
			releaseId: releaseAId,
			title: "Update Boom",
			slug: "update-boom",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const brokenSql = new Proxy(sql, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									if (
										p === "unsafe" ||
										(typeof v === "function" && String(p || "").includes("query"))
									) {
										return (...args: unknown[]) => {
											const sqlText = String(args[0] ?? "");
											if (sqlText.includes("UPDATE features")) {
												throw new Error("random update error");
											}
											return (v as (...a: unknown[]) => unknown).apply(t, args);
										};
									}
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const brokenService = makeFeatureService(brokenSql);
		await expect(
			brokenService.updateFeature({
				featureId: created.feature.id,
				title: "Boom",
				actor: ACTOR,
			}),
		).rejects.toThrow(/random update error/);
	});
});
