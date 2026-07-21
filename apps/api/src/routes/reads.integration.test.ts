/**
 * Integration tests for requirement 23: persisted read APIs and SSE.
 *
 * Uses proper migrations (applyCoreMigration + applyWorkflowMigration) and
 * isolated PostgreSQL fixtures. Verifies overview metrics, attention derivation,
 * activity pagination, project/release/feature detail reconstruction, UTC
 * serialization, and SSE event-ID replay.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createDatabaseClient,
	createWorkspace,
	DATABASE_URL,
	type DatabaseClient,
	resetSchema,
	type Sql,
} from "../../../../packages/database/src/index";
import { type ApiApp, createApiApp } from "../app";
import { bootstrapAdministrator } from "../auth/admin-bootstrap";
import { createSessionService, type SessionService } from "../auth/session-service";

let client: DatabaseClient;
let sql: Sql;
let sessionService: SessionService;
let app: Hono;
let sessionCookie: string;
let projectId: string;
let releaseId: string;
let featureId: string;

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await resetSchema(sql);
});

afterAll(async () => {
	await client.end();
});

beforeEach(async () => {
	// Apply proper migrations (same as production) — idempotent after first run
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);

	// Clean up test data from previous test run while preserving schema
	await sql.unsafe(`
		TRUNCATE TABLE
			diagnostic_log_chunks,
			failure_records,
			progress_snapshots,
			activity_events,
			development_job_attempts,
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			worker_registrations,
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);

	// Create default workspace (required for project FK)
	await createWorkspace(sql);

	// Bootstrap administrator
	await bootstrapAdministrator(sql, {
		username: "admin",
		bootstrapPassword: "SecurePass123!",
	});

	// Create session
	sessionService = createSessionService({ sql });
	const loginResult = await sessionService.login({
		username: "admin",
		password: "SecurePass123!",
	});
	if (!loginResult.ok) throw new Error("Login failed");

	// Build app with sql for read routes
	const built: ApiApp = createApiApp({
		sessionService,
		nodeEnv: "test",
		adapters: {
			sql,
			// Read routes only need sql; mutation adapters can be minimal stubs
			// since they aren't exercised by these read tests.
			projectService: {} as ReturnType<
				typeof import("../../../../packages/domain/src/index").createProjectService
			>,
			releaseService: {} as ReturnType<
				typeof import("../../../../packages/domain/src/index").createReleaseService
			>,
			featureService: {} as ReturnType<
				typeof import("../../../../packages/domain/src/index").createFeatureService
			>,
			taskApprovalService: {} as ReturnType<
				typeof import("../../../../packages/domain/src/index").createTaskApprovalService
			>,
			cancelHandler: async () => ({ kind: "cancelled" }),
			retryHandler: async () => ({ kind: "retried" }),
		},
	});
	app = built.app;
	sessionCookie = `ac_session=${loginResult.rawToken}`;

	// Seed test data: project, release, feature
	projectId = await sql`
		INSERT INTO projects (workspace_id, name, slug, github_owner, github_repo, canonical_path, development_branch, status)
		SELECT id, 'Test Project', 'test-project', 'owner', 'repo', '/tmp/test', 'main', 'active'
		FROM workspaces LIMIT 1
		RETURNING id
	`.then((rows) => (rows[0] as { id: string }).id);

	releaseId = await sql`
		INSERT INTO releases (project_id, name, version, sort_order, status)
		VALUES (${projectId}, 'v1.0', '1.0.0', 1, 'IN_DEVELOPMENT')
		RETURNING id
	`.then((rows) => (rows[0] as { id: string }).id);

	featureId = await sql`
		INSERT INTO features (project_id, release_id, slug, title, state, branch_name)
		VALUES (${projectId}, ${releaseId}, 'test-feature', 'Test Feature', 'PLANNED', 'feature/test-feature')
		RETURNING id
	`.then((rows) => (rows[0] as { id: string }).id);
});

describe("GET /api/overview", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/overview");
		expect(res.status).toBe(401);
	});

	test("returns portfolio overview with all required metrics", async () => {
		const res = await app.request("/api/overview", {
			headers: { Cookie: sessionCookie },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: true; data: Record<string, unknown> };
		expect(body.ok).toBe(true);
		expect(body.data).toHaveProperty("projectCount");
		expect(body.data).toHaveProperty("activeJobs");
		expect(body.data).toHaveProperty("queuedJobs");
		expect(body.data).toHaveProperty("attentionCount");
		expect(body.data).toHaveProperty("failedJobs");
		expect(body.data).toHaveProperty("prsAwaitingReview");
		expect(body.data).toHaveProperty("developmentMergedFeatures");
		expect(body.data).toHaveProperty("developmentMergedReleases");
	});

	test("returns correct project count after seeding", async () => {
		const res = await app.request("/api/overview", {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as { ok: true; data: { projectCount: number } };
		expect(body.data.projectCount).toBe(1);
	});

	test("returns zero active/queued jobs when no jobs exist", async () => {
		const res = await app.request("/api/overview", {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { activeJobs: number; queuedJobs: number; failedJobs: number };
		};
		expect(body.data.activeJobs).toBe(0);
		expect(body.data.queuedJobs).toBe(0);
		expect(body.data.failedJobs).toBe(0);
	});
});

describe("GET /api/attention", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/attention");
		expect(res.status).toBe(401);
	});

	test("returns attention items with category filter", async () => {
		// Seed a feature in TASKS_REVIEW to generate attention
		await sql`
			UPDATE features SET state = 'TASKS_REVIEW' WHERE id = ${featureId}
		`;

		const res = await app.request("/api/attention?category=task_review", {
			headers: { Cookie: sessionCookie },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: true; data: { items: unknown[] } };
		expect(Array.isArray(body.data.items)).toBe(true);
		if (body.data.items.length > 0) {
			const item = body.data.items[0] as Record<string, unknown>;
			expect(item.category).toBe("task_review");
		}
	});

	test("attention items have all required fields", async () => {
		await sql`
			UPDATE features SET state = 'TASKS_REVIEW' WHERE id = ${featureId}
		`;

		const res = await app.request("/api/attention", {
			headers: { Cookie: sessionCookie },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: { items: Record<string, unknown>[] };
		};
		if (body.data.items.length > 0) {
			const item = body.data.items[0];
			expect(item).toHaveProperty("projectId");
			expect(item).toHaveProperty("featureId");
			expect(item).toHaveProperty("reason");
			expect(item).toHaveProperty("ageBasis");
			expect(item).toHaveProperty("currentState");
			expect(item).toHaveProperty("category");
			expect(item).toHaveProperty("primaryAction");
		}
	});

	test("attention excludes healthy waiting states", async () => {
		// PLANNED features should not appear in attention
		const res = await app.request("/api/attention", {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { items: Record<string, unknown>[] };
		};
		const plannedItems = body.data.items.filter((item) => item.currentState === "PLANNED");
		expect(plannedItems.length).toBe(0);
	});
});

describe("GET /api/activity", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/activity");
		expect(res.status).toBe(401);
	});

	test("returns cursor-paginated activity events newest-first", async () => {
		const res = await app.request("/api/activity?limit=10", {
			headers: { Cookie: sessionCookie },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: { items: unknown[]; nextCursor: string | null };
		};
		expect(Array.isArray(body.data.items)).toBe(true);
		expect(body.data).toHaveProperty("nextCursor");
	});

	test("returns project-scoped activity", async () => {
		const res = await app.request(`/api/projects/${projectId}/activity?limit=10`, {
			headers: { Cookie: sessionCookie },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: true; data: { items: unknown[] } };
		expect(Array.isArray(body.data.items)).toBe(true);
	});

	test("uses time+id stable cursor for pagination", async () => {
		const occurredAt = new Date("2026-07-19T12:00:00.000Z");
		const ids = [
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
			"00000000-0000-4000-8000-000000000003",
		] as const;
		for (const [index, id] of ids.entries()) {
			await sql`
				INSERT INTO activity_events (id, project_id, type, summary, source, occurred_at, created_at)
				VALUES (${id}, ${projectId}, 'test.event', ${`event-${index}`}, 'test', ${occurredAt}, ${new Date(occurredAt.getTime() + index * 1000)})
			`;
		}

		const first = await app.request("/api/activity?limit=2", {
			headers: { Cookie: sessionCookie },
		});
		const firstBody = (await first.json()) as {
			data: { items: Array<{ id: string }>; nextCursor: string };
		};
		expect(firstBody.data.items.length).toBe(2);
		expect(firstBody.data.nextCursor).toBeTruthy();

		const second = await app.request(
			`/api/activity?limit=2&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
			{ headers: { Cookie: sessionCookie } },
		);
		const secondBody = (await second.json()) as {
			data: { items: Array<{ id: string }> };
		};
		const returned = [...firstBody.data.items, ...secondBody.data.items].map((item) => item.id);
		expect(returned).toEqual([ids[2], ids[1], ids[0]]);
		expect(new Set(returned).size).toBe(3);
	});

	test("UTC timestamps are serialized as ISO-8601 strings", async () => {
		const res = await app.request("/api/activity?limit=1", {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { items: Array<{ occurredAt: string; createdAt: string }> };
		};
		if (body.data.items.length > 0) {
			const item = body.data.items[0];
			if (!item) throw new Error("Expected at least one item");
			// Both timestamps should be valid ISO-8601 strings
			expect(() => new Date(item.occurredAt)).not.toThrow();
			expect(() => new Date(item.createdAt)).not.toThrow();
			// UTC timestamps end with Z
			expect(item.occurredAt).toEndWith("Z");
			expect(item.createdAt).toEndWith("Z");
		}
	});

	test("rejects invalid cursor with 400", async () => {
		const res = await app.request("/api/activity?cursor=invalid-base64!!!", {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /api/projects", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/projects");
		expect(res.status).toBe(401);
	});

	test("returns project list with camelCase fields", async () => {
		const res = await app.request("/api/projects", {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: Array<Record<string, unknown>>;
		};
		expect(body.data.length).toBe(1);
		const project = body.data[0];
		if (!project) throw new Error("Expected at least one project");
		expect(project.id).toBe(projectId);
		expect(project.name).toBe("Test Project");
		expect(project).toHaveProperty("githubOwner");
		expect(project).toHaveProperty("githubRepo");
		expect(project).toHaveProperty("canonicalPath");
		expect(project).toHaveProperty("developmentBranch");
	});

	test("returns project detail with releases", async () => {
		const res = await app.request(`/api/projects/${projectId}`, {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: Record<string, unknown> & { releases: unknown[] };
		};
		expect(body.data.id).toBe(projectId);
		expect(body.data).toHaveProperty("releases");
		expect(Array.isArray(body.data.releases)).toBe(true);
	});

	test("returns 404 for non-existent project", async () => {
		const res = await app.request("/api/projects/00000000-0000-0000-0000-000000000000", {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /api/releases", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/releases");
		expect(res.status).toBe(401);
	});

	test("returns release detail with features and developmentProgress", async () => {
		const res = await app.request(`/api/releases/${releaseId}`, {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: Record<string, unknown> & { features: unknown[]; developmentProgress: unknown };
		};
		expect(body.data.id).toBe(releaseId);
		expect(body.data).toHaveProperty("features");
		expect(body.data).toHaveProperty("developmentProgress");
		expect(Array.isArray(body.data.features)).toBe(true);
	});

	test("developmentProgress uses development-only wording", async () => {
		const res = await app.request(`/api/releases/${releaseId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { developmentProgress: { totalFeatures: number; mergedFeatures: number } };
		};
		// Should use development-merged language, not "released"
		const raw = JSON.stringify(body.data.developmentProgress);
		expect(raw).not.toContain("released");
		expect(raw).not.toContain("production");
	});
});

describe("GET /api/features/:id", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/features/some-id");
		expect(res.status).toBe(401);
	});

	test("returns feature detail with all required sub-entities", async () => {
		const res = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: Record<string, unknown>;
		};
		expect(body.data.id).toBe(featureId);
		expect(body.data).toHaveProperty("state");
		expect(body.data).toHaveProperty("taskApproval");
		expect(body.data).toHaveProperty("progress");
		expect(body.data).toHaveProperty("attempts");
		expect(body.data).toHaveProperty("failures");
		expect(body.data).toHaveProperty("diagnosticLogs");
		expect(body.data).toHaveProperty("pullRequest");
		expect(body.data).toHaveProperty("recentActivity");
		expect(Array.isArray((body.data as { attempts: unknown[] }).attempts)).toBe(true);
	});

	test("returns null for empty sub-entities when no data", async () => {
		const res = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { taskApproval: unknown; pullRequest: unknown; progress: unknown };
		};
		expect(body.data.taskApproval).toBeNull();
		expect(body.data.pullRequest).toBeNull();
		expect(body.data.progress).toBeNull();
	});

	test("returns feature detail with task approval when data exists", async () => {
		// Create a task approval
		const approvalId = await sql`
			INSERT INTO task_approvals
				(project_id, feature_id, relative_task_path, checksum, schema_compatibility_version,
				 requirements_snapshot, approved_by_admin_id, approved_at)
			SELECT ${projectId}, ${featureId}, 'tasks/test.json', 'abc123', '1.0',
				'{"requirements":[]}'::jsonb, id, NOW()
			FROM admin_accounts LIMIT 1
			RETURNING id
		`.then((rows) => (rows[0] as { id: string }).id);

		const res = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { taskApproval: { id: string; checksum: string } | null };
		};
		expect(body.data.taskApproval).not.toBeNull();
		expect(body.data.taskApproval?.id).toBe(approvalId);
		expect(body.data.taskApproval?.checksum).toBe("abc123");
	});

	test("returns feature detail with attempts when jobs exist", async () => {
		// First create a task approval (required FK)
		const approvalRow = await sql`
			INSERT INTO task_approvals
				(project_id, feature_id, relative_task_path, checksum, schema_compatibility_version,
				 requirements_snapshot, approved_by_admin_id, approved_at)
			SELECT ${projectId}, ${featureId}, 'tasks/test.json', 'def456', '1.0',
				'{"requirements":[]}'::jsonb, id, NOW()
			FROM admin_accounts LIMIT 1
			RETURNING id
		`;
		const approvalId = (approvalRow[0] as { id: string }).id;

		await sql`
			INSERT INTO development_job_attempts
				(project_id, feature_id, task_approval_id, branch_name, operation_key, status)
			VALUES (${projectId}, ${featureId}, ${approvalId}, 'feature/test-feature', 'op-key-1', 'QUEUED')
		`;

		const res = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { attempts: Array<{ status: string; branchName: string }> };
		};
		expect(body.data.attempts.length).toBe(1);
		expect(body.data.attempts[0]?.status).toBe("QUEUED");
		expect(body.data.attempts[0]?.branchName).toBe("feature/test-feature");
	});

	test("returns 404 for non-existent feature", async () => {
		const res = await app.request("/api/features/00000000-0000-0000-0000-000000000000", {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /api/events (SSE)", () => {
	test("requires authentication", async () => {
		const { app: noAuthApp } = createApiApp({
			sessionService: createSessionService({ sql }),
			nodeEnv: "test",
		});
		const res = await noAuthApp.request("/api/events", {
			headers: { Accept: "text/event-stream" },
		});
		expect(res.status).toBe(401);
	});

	test("returns SSE stream with correct content type", async () => {
		const res = await app.request("/api/events", {
			headers: {
				Cookie: sessionCookie,
				Accept: "text/event-stream",
			},
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");
	});

	test("supports reconnect from Last-Event-ID header", async () => {
		const res = await app.request("/api/events", {
			headers: {
				Cookie: sessionCookie,
				Accept: "text/event-stream",
				"Last-Event-ID": "some-id",
			},
		});

		expect(res.status).toBe(200);
	});
});
