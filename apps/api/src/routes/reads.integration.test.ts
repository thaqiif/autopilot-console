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
	createIsolatedTestDatabase,
	createWorkspace,
	DATABASE_URL,
	type DatabaseClient,
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
	client = await createIsolatedTestDatabase(DATABASE_URL);
	sql = client.sql;
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

afterAll(async () => {
	await client.end();
});

beforeEach(async () => {
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

async function createTaskApproval(
	checksum: string,
	requirements: Parameters<Sql["json"]>[0] = [],
): Promise<string> {
	return sql`
		INSERT INTO task_approvals
			(project_id, feature_id, relative_task_path, checksum, schema_compatibility_version,
			 requirements_snapshot, approved_by_admin_id, approved_at)
		SELECT ${projectId}, ${featureId}, 'tasks/test.json', ${checksum}, '1.0',
			${sql.json({ requirements })}, id, NOW()
		FROM admin_accounts LIMIT 1
		RETURNING id
	`.then((rows) => (rows[0] as { id: string }).id);
}

async function createAttempt(
	approvalId: string,
	status: "QUEUED" | "RUNNING" | "FAILED" | "INTERRUPTED" = "QUEUED",
): Promise<string> {
	return sql`
		INSERT INTO development_job_attempts
			(project_id, feature_id, task_approval_id, branch_name, operation_key, status,
			 enqueued_at)
		VALUES (
			${projectId},
			${featureId},
			${approvalId},
			'feature/test-feature',
			${`op-key-${crypto.randomUUID()}`},
			${status},
			NOW()
		)
		RETURNING id
	`.then((rows) => (rows[0] as { id: string }).id);
}

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

	test("uses persisted release status and stale-sync failures for exact portfolio metrics", async () => {
		await sql`UPDATE features SET state = 'DEVELOPMENT_MERGED' WHERE id = ${featureId}`;
		await sql`
			INSERT INTO failure_records
				(project_id, feature_id, category, summary, recommended_action)
			VALUES (
				${projectId},
				${featureId},
				'stale_github_sync',
				'GitHub observations are stale',
				'Refresh GitHub status'
			)
		`;

		const beforeMerge = await app.request("/api/overview", {
			headers: { Cookie: sessionCookie },
		});
		const beforeBody = (await beforeMerge.json()) as {
			data: {
				attentionCount: number;
				developmentMergedFeatures: number;
				developmentMergedReleases: number;
			};
		};
		expect(beforeBody.data).toMatchObject({
			attentionCount: 1,
			developmentMergedFeatures: 1,
			developmentMergedReleases: 0,
		});

		await sql`
			UPDATE releases SET status = 'DEVELOPMENT_MERGED' WHERE id = ${releaseId}
		`;
		const afterMerge = await app.request("/api/overview", {
			headers: { Cookie: sessionCookie },
		});
		const afterBody = (await afterMerge.json()) as {
			data: { developmentMergedReleases: number };
		};
		expect(afterBody.data.developmentMergedReleases).toBe(1);
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

	test("derives stale GitHub sync attention from persisted failures", async () => {
		await sql`
			INSERT INTO failure_records
				(project_id, feature_id, category, summary, recommended_action, occurred_at)
			VALUES (
				${projectId},
				${featureId},
				'stale_github_sync',
				'GitHub polling repeatedly failed',
				'Refresh GitHub status',
				'2026-07-29T20:00:00.000Z'
			)
		`;

		const res = await app.request("/api/attention?category=stale_github_sync", {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			ok: true;
			data: { items: Array<Record<string, unknown>> };
		};
		expect(res.status).toBe(200);
		expect(body.data.items).toEqual([
			expect.objectContaining({
				projectId,
				releaseId,
				featureId,
				reason: "stale_github_sync",
				ageBasis: "2026-07-29T20:00:00.000Z",
				currentState: "PLANNED",
				primaryAction: "refresh_github_status",
			}),
		]);
	});

	test("applies project and release filters and rejects unsupported categories", async () => {
		await sql`UPDATE features SET state = 'TASKS_REVIEW' WHERE id = ${featureId}`;

		const filtered = await app.request(
			`/api/attention?projectId=00000000-0000-4000-8000-000000000099&releaseId=${releaseId}`,
			{ headers: { Cookie: sessionCookie } },
		);
		const filteredBody = (await filtered.json()) as { data: { items: unknown[] } };
		expect(filtered.status).toBe(200);
		expect(filteredBody.data.items).toEqual([]);

		const invalid = await app.request("/api/attention?category=not-a-category", {
			headers: { Cookie: sessionCookie },
		});
		expect(invalid.status).toBe(400);
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

	test("reconstructs mutable requirement phases, blockers, and active worker timing", async () => {
		const requirements = [
			{
				id: "1",
				description: "Completed requirement",
				acceptance: ["done"],
				dependsOn: [],
				passes: true,
				tdd: {
					test: { passes: true },
					implement: { passes: true },
					refactor: { passes: true },
				},
			},
			{
				id: "2",
				description: "Active requirement",
				acceptance: ["in progress"],
				dependsOn: ["1"],
				passes: false,
				tdd: {
					test: { passes: true },
					implement: { passes: false },
					refactor: { passes: false },
				},
			},
			{
				id: "3",
				description: "Blocked requirement",
				acceptance: ["blocked"],
				dependsOn: ["2"],
				passes: false,
				stuck: true,
				blockedReason: "External dependency unavailable",
				tdd: {
					test: { passes: false },
					implement: { passes: false },
					refactor: { passes: false },
				},
			},
		];
		const approvalId = await createTaskApproval("progress-checksum", requirements);
		const [worker] = await sql`
			INSERT INTO worker_registrations
				(worker_id, hostname, capacity, active_jobs, last_heartbeat_at)
			VALUES ('worker-23', 'worker-host', 4, 1, '2026-07-29T20:02:00.000Z')
			RETURNING id
		`;
		const attemptId = await createAttempt(approvalId, "RUNNING");
		await sql`
			UPDATE development_job_attempts
			SET worker_registration_id = ${worker?.id},
				process_pid = 2300,
				started_at = '2026-07-29T20:00:00.000Z',
				heartbeat_at = '2026-07-29T20:02:00.000Z'
			WHERE id = ${attemptId}
		`;
		await sql`
			INSERT INTO progress_snapshots
				(project_id, feature_id, attempt_id, source_version, summary, requirements, created_at)
			VALUES (
				${projectId},
				${featureId},
				${attemptId},
				7,
				${sql.json({ activeRequirementId: "2" })},
				${sql.json(requirements)},
				'2026-07-29T20:02:00.000Z'
			)
		`;

		const res = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			data: {
				progress: {
					totalRequirements: number;
					passedRequirements: number;
					activeRequirements: number;
					stuckRequirements: number;
					remainingRequirements: number;
					activeRequirementId: string;
					requirements: Array<Record<string, unknown>>;
				};
				activeAttempt: {
					id: string;
					worker: { workerId: string; hostname: string; capacity: number };
					heartbeatAt: string;
					startedAt: string;
				};
			};
		};

		expect(res.status).toBe(200);
		expect(body.data.progress).toMatchObject({
			totalRequirements: 3,
			passedRequirements: 1,
			activeRequirements: 1,
			stuckRequirements: 1,
			remainingRequirements: 1,
			activeRequirementId: "2",
		});
		expect(body.data.progress.requirements[1]).toMatchObject({
			id: "2",
			dependsOn: ["1"],
			blockedReason: null,
			phases: { red: true, green: false, refactor: false },
		});
		expect(body.data.progress.requirements[2]).toMatchObject({
			id: "3",
			blockedReason: "External dependency unavailable",
			status: "stuck",
		});
		expect(body.data.activeAttempt).toMatchObject({
			id: attemptId,
			worker: { workerId: "worker-23", hostname: "worker-host", capacity: 4 },
			heartbeatAt: "2026-07-29T20:02:00.000Z",
			startedAt: "2026-07-29T20:00:00.000Z",
		});
	});

	test("exposes an authenticated job-detail projection for a persisted attempt", async () => {
		const approvalId = await createTaskApproval("job-detail-checksum");
		const attemptId = await createAttempt(approvalId, "QUEUED");

		const res = await app.request(`/api/jobs/${attemptId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			data: {
				id: string;
				feature: { id: string; projectId: string; releaseId: string };
				attemptHistory: Array<{ id: string }>;
				diagnosticLogs: unknown[];
				failures: unknown[];
				recentActivity: unknown[];
			};
		};

		expect(res.status).toBe(200);
		expect(body.data).toMatchObject({
			id: attemptId,
			feature: { id: featureId, projectId, releaseId },
			attemptHistory: [{ id: attemptId }],
			diagnosticLogs: [],
			failures: [],
			recentActivity: [],
		});
	});

	test("bounds diagnostic logs to the newest 100 chunks", async () => {
		const approvalId = await createTaskApproval("bounded-log-checksum");
		const attemptId = await createAttempt(approvalId);
		for (let sequence = 1; sequence <= 101; sequence += 1) {
			await sql`
				INSERT INTO diagnostic_log_chunks
					(project_id, attempt_id, sequence, stream, body, created_at)
				VALUES (
					${projectId},
					${attemptId},
					${sequence},
					'stdout',
					${`line-${sequence}`},
					${new Date(Date.UTC(2026, 6, 29, 20, 0, sequence))}
				)
			`;
		}

		const res = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		const body = (await res.json()) as {
			data: { diagnosticLogs: Array<{ sequence: number; body: string }> };
		};
		expect(body.data.diagnosticLogs).toHaveLength(100);
		expect(body.data.diagnosticLogs[0]).toMatchObject({ sequence: 101, body: "line-101" });
		expect(body.data.diagnosticLogs.at(-1)).toMatchObject({ sequence: 2, body: "line-2" });
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
		await res.body?.cancel();
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
		await res.body?.cancel();
	});

	test("signals an explicit reconciliation gap when Last-Event-ID is no longer available", async () => {
		await sql`
			INSERT INTO activity_events
				(project_id, feature_id, type, summary, source, occurred_at)
			VALUES (
				${projectId},
				${featureId},
				'feature.updated',
				'Feature updated',
				'test',
				'2026-07-29T20:00:00.000Z'
			)
		`;

		const res = await app.request("/api/events", {
			headers: {
				Cookie: sessionCookie,
				Accept: "text/event-stream",
				"Last-Event-ID": "00000000-0000-4000-8000-000000000099",
			},
		});
		const reader = res.body?.getReader();
		const chunk = await reader?.read();
		const text = new TextDecoder().decode(chunk?.value);
		await reader?.cancel();

		expect(text).toContain("event: reconcile");
		expect(text).toContain('"reason":"event_gap"');
		expect(text).toContain('"reload":"/api/overview"');
	});

	test("replays persisted events and REST reconstructs the identical authoritative state", async () => {
		const [marker] = await sql`
			INSERT INTO activity_events
				(project_id, feature_id, type, summary, source, occurred_at)
			VALUES (
				${projectId},
				${featureId},
				'feature.created',
				'Feature created',
				'test',
				'2026-07-29T20:00:00.000Z'
			)
			RETURNING id
		`;
		await sql`
			UPDATE features
			SET state = 'TASKS_REVIEW', updated_at = '2026-07-29T20:01:00.000Z'
			WHERE id = ${featureId}
		`;
		const [changed] = await sql`
			INSERT INTO activity_events
				(project_id, feature_id, type, summary, source, metadata, occurred_at)
			VALUES (
				${projectId},
				${featureId},
				'feature.state_changed',
				'Feature moved to task review',
				'test',
				${sql.json({ state: "TASKS_REVIEW" })},
				'2026-07-29T20:01:00.000Z'
			)
			RETURNING id
		`;

		const stream = await app.request("/api/events", {
			headers: {
				Cookie: sessionCookie,
				Accept: "text/event-stream",
				"Last-Event-ID": String(marker?.id),
			},
		});
		const reader = stream.body?.getReader();
		const chunk = await reader?.read();
		const text = new TextDecoder().decode(chunk?.value);
		await reader?.cancel();
		expect(text).toContain(`id: ${String(changed?.id)}`);
		expect(text).toContain('"state":"TASKS_REVIEW"');

		const rest = await app.request(`/api/features/${featureId}`, {
			headers: { Cookie: sessionCookie },
		});
		const restBody = (await rest.json()) as { data: { state: string } };
		expect(restBody.data.state).toBe("TASKS_REVIEW");
	});
});
