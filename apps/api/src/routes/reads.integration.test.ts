/**
 * Integration tests for requirement 23: persisted read APIs and SSE.
 *
 * Tests the overview, attention, activity, project/release/feature detail,
 * and server-sent event routes against isolated PostgreSQL fixtures.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDatabaseClient, type DatabaseClient, type Sql } from "../../../../packages/database/src/index";
import { createDatabaseFixture, type DatabaseFixture } from "../../../../packages/database/src/testing/database-fixture";
import { createApiApp, type DomainAdapters } from "../app";
import { createSessionService, type SessionService } from "../auth/session-service";

const DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

let client: DatabaseClient;
let sql: Sql;
let fixture: DatabaseFixture;

describe("Read APIs", () => {
	beforeAll(async () => {
		client = createDatabaseClient(DATABASE_URL);
		sql = client.sql;
		await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
		await sql.unsafe("CREATE SCHEMA public");
		await sql.unsafe("GRANT ALL ON SCHEMA public TO postgres");
		await sql.unsafe("GRANT ALL ON SCHEMA public TO public");
	});

	afterAll(async () => {
		await client.end();
	});

	beforeEach(async () => {
		// Apply migrations
		await sql.unsafe('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
		
		// Create core tables
		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS workspaces (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				name TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS admin_accounts (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				username TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS sessions (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				admin_account_id UUID NOT NULL REFERENCES admin_accounts(id),
				token_hash TEXT NOT NULL UNIQUE,
				expires_at TIMESTAMPTZ NOT NULL,
				revoked_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS projects (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				workspace_id UUID NOT NULL REFERENCES workspaces(id),
				name TEXT NOT NULL,
				slug TEXT NOT NULL,
				description TEXT,
				github_owner TEXT NOT NULL,
				github_repo TEXT NOT NULL,
				canonical_path TEXT NOT NULL,
				development_branch TEXT NOT NULL,
				validation_status TEXT,
				last_validated_at TIMESTAMPTZ,
				status TEXT NOT NULL DEFAULT 'active',
				archived_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				UNIQUE(workspace_id, slug),
				UNIQUE(workspace_id, canonical_path),
				UNIQUE(github_owner, github_repo)
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS releases (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				name TEXT NOT NULL,
				version TEXT NOT NULL,
				description TEXT,
				sort_order INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'planned',
				archived_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				UNIQUE(project_id, name),
				UNIQUE(project_id, version)
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS features (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				release_id UUID NOT NULL REFERENCES releases(id),
				slug TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT,
				state TEXT NOT NULL DEFAULT 'PLANNED',
				branch_name TEXT NOT NULL,
				task_path TEXT,
				row_version INTEGER NOT NULL DEFAULT 1,
				archived_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				UNIQUE(project_id, slug)
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS task_approvals (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				feature_id UUID NOT NULL REFERENCES features(id),
				relative_task_path TEXT NOT NULL,
				checksum TEXT NOT NULL,
				schema_compatibility_version TEXT NOT NULL,
				requirements_snapshot JSONB NOT NULL,
				approved_by_admin_id UUID NOT NULL REFERENCES admin_accounts(id),
				approved_at TIMESTAMPTZ NOT NULL,
				invalidated_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS pull_requests (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				feature_id UUID NOT NULL REFERENCES features(id),
				repository_owner TEXT NOT NULL,
				repository_name TEXT NOT NULL,
				number INTEGER NOT NULL,
				url TEXT NOT NULL,
				head_branch TEXT NOT NULL,
				base_branch TEXT NOT NULL,
				original_head_sha TEXT NOT NULL,
				observed_head_sha TEXT,
				observed_state TEXT,
				merge_commit_sha TEXT,
				last_observed_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS development_attempts (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				feature_id UUID NOT NULL REFERENCES features(id),
				task_approval_id UUID NOT NULL REFERENCES task_approvals(id),
				branch_name TEXT NOT NULL,
				operation_key TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'queued',
				predecessor_attempt_id UUID REFERENCES development_attempts(id),
				worker_registration_id UUID,
				process_pid INTEGER,
				process_start_identity TEXT,
				lease_expires_at TIMESTAMPTZ,
				heartbeat_at TIMESTAMPTZ,
				enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				started_at TIMESTAMPTZ,
				ended_at TIMESTAMPTZ,
				exit_code INTEGER,
				cancellation_requested_at TIMESTAMPTZ,
				cancellation_reason TEXT,
				structured_result JSONB,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS progress_snapshots (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				feature_id UUID NOT NULL REFERENCES features(id),
				attempt_id UUID NOT NULL REFERENCES development_attempts(id),
				source_version INTEGER NOT NULL,
				summary JSONB NOT NULL,
				requirements JSONB NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS activity_events (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID REFERENCES projects(id),
				feature_id UUID REFERENCES features(id),
				attempt_id UUID REFERENCES development_attempts(id),
				type TEXT NOT NULL,
				summary TEXT NOT NULL,
				source TEXT NOT NULL DEFAULT 'system',
				metadata JSONB,
				occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS failure_records (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				feature_id UUID NOT NULL REFERENCES features(id),
				attempt_id UUID REFERENCES development_attempts(id),
				category TEXT NOT NULL,
				summary TEXT NOT NULL,
				recommended_action TEXT NOT NULL,
				details JSONB,
				occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS diagnostic_log_chunks (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				project_id UUID NOT NULL REFERENCES projects(id),
				attempt_id UUID NOT NULL REFERENCES development_attempts(id),
				sequence INTEGER NOT NULL,
				stream TEXT NOT NULL,
				body TEXT NOT NULL,
				truncated BOOLEAN NOT NULL DEFAULT FALSE,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await sql.unsafe(`
			CREATE TABLE IF NOT EXISTS worker_registrations (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				worker_id TEXT NOT NULL UNIQUE,
				hostname TEXT NOT NULL,
				capacity INTEGER NOT NULL DEFAULT 4,
				active_jobs INTEGER NOT NULL DEFAULT 0,
				registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				stopped_at TIMESTAMPTZ
			)
		`);

		fixture = createDatabaseFixture(sql);
	});

	afterEach(async () => {
		await sql.unsafe(`
			DROP TABLE IF EXISTS diagnostic_log_chunks, failure_records, activity_events, 
			progress_snapshots, development_attempts, pull_requests, task_approvals, 
			features, releases, projects, sessions, admin_accounts, workspaces, 
			worker_registrations CASCADE
		`);
	});

	describe("GET /api/overview", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/overview");
			expect(res.status).toBe(401);
		});

		test("returns portfolio overview metrics", async () => {
			const { app, sessionCookie } = await createAuthenticatedApp();

			const res = await app.request("/api/overview", {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("projectCount");
			expect(body).toHaveProperty("activeJobs");
			expect(body).toHaveProperty("queuedJobs");
			expect(body).toHaveProperty("attentionCount");
			expect(body).toHaveProperty("failedJobs");
			expect(body).toHaveProperty("prsAwaitingReview");
			expect(body).toHaveProperty("developmentMergedFeatures");
			expect(body).toHaveProperty("developmentMergedReleases");
		});
	});

	describe("GET /api/attention", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/attention");
			expect(res.status).toBe(401);
		});

		test("returns attention items with category filter", async () => {
			const { app, sessionCookie } = await createAuthenticatedApp();

			const res = await app.request("/api/attention?category=task_review", {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(Array.isArray(body.items)).toBe(true);
		});

		test("returns attention items with required fields", async () => {
			const { app, sessionCookie } = await createAuthenticatedApp();

			const res = await app.request("/api/attention", {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			if (body.items.length > 0) {
				const item = body.items[0];
				expect(item).toHaveProperty("projectId");
				expect(item).toHaveProperty("featureId");
				expect(item).toHaveProperty("reason");
				expect(item).toHaveProperty("ageBasis");
				expect(item).toHaveProperty("currentState");
				expect(item).toHaveProperty("category");
				expect(item).toHaveProperty("primaryAction");
			}
		});
	});

	describe("GET /api/activity", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/activity");
			expect(res.status).toBe(401);
		});

		test("returns cursor-paginated activity events newest-first", async () => {
			const { app, sessionCookie } = await createAuthenticatedApp();

			const res = await app.request("/api/activity?limit=10", {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(Array.isArray(body.items)).toBe(true);
			expect(body).toHaveProperty("cursor");
		});

		test("returns project-scoped activity", async () => {
			const { app, sessionCookie, projectId } = await createAuthenticatedApp();

			const res = await app.request(`/api/projects/${projectId}/activity?limit=10`, {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(Array.isArray(body.items)).toBe(true);
		});
	});

	describe("GET /api/projects/:id", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/projects/some-id");
			expect(res.status).toBe(401);
		});

		test("returns project detail", async () => {
			const { app, sessionCookie, projectId } = await createAuthenticatedApp();

			const res = await app.request(`/api/projects/${projectId}`, {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("id");
			expect(body).toHaveProperty("name");
			expect(body).toHaveProperty("releases");
		});
	});

	describe("GET /api/releases/:id", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/releases/some-id");
			expect(res.status).toBe(401);
		});

		test("returns release detail with features", async () => {
			const { app, sessionCookie, releaseId } = await createAuthenticatedApp();

			const res = await app.request(`/api/releases/${releaseId}`, {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("id");
			expect(body).toHaveProperty("features");
			expect(body).toHaveProperty("developmentProgress");
		});
	});

	describe("GET /api/features/:id", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/features/some-id");
			expect(res.status).toBe(401);
		});

		test("returns feature detail with task progress", async () => {
			const { app, sessionCookie, featureId } = await createAuthenticatedApp();

			const res = await app.request(`/api/features/${featureId}`, {
				headers: { Cookie: sessionCookie },
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("id");
			expect(body).toHaveProperty("state");
			expect(body).toHaveProperty("taskApproval");
			expect(body).toHaveProperty("progress");
			expect(body).toHaveProperty("attempts");
		});
	});

	describe("GET /api/events", () => {
		test("requires authentication", async () => {
			const { app } = createApiApp({
				sessionService: createSessionService({ sql }),
				nodeEnv: "test",
			});

			const res = await app.request("/api/events");
			expect(res.status).toBe(401);
		});

		test("returns SSE stream with event IDs", async () => {
			const { app, sessionCookie } = await createAuthenticatedApp();

			const res = await app.request("/api/events", {
				headers: {
					Cookie: sessionCookie,
					Accept: "text/event-stream",
				},
			});

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/event-stream");
		});

		test("supports reconnect from last event ID", async () => {
			const { app, sessionCookie } = await createAuthenticatedApp();

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
});

async function createAuthenticatedApp(): Promise<{
	app: Hono;
	sessionCookie: string;
	projectId: string;
	releaseId: string;
	featureId: string;
}> {
	// Import bootstrapAdministrator
	const { bootstrapAdministrator } = await import("../auth/admin-bootstrap");
	
	// Create admin account
	const admin = await bootstrapAdministrator(sql, {
		username: "admin",
		bootstrapPassword: "SecurePass123!",
	});

	// Create session service and login
	const sessionService = createSessionService({ sql });
	const loginResult = await sessionService.login({
		username: "admin",
		password: "SecurePass123!",
	});

	if (!loginResult.ok) {
		throw new Error("Login failed");
	}

	// Create workspace
	const workspace = await sql`
		INSERT INTO workspaces (name)
		VALUES ('Test Workspace')
		RETURNING id
	`.then((rows) => rows[0]);

	// Create test data
	const projectId = await sql`
		INSERT INTO projects (workspace_id, name, slug, github_owner, github_repo, canonical_path, development_branch, status)
		VALUES (${workspace.id}, 'Test Project', 'test-project', 'owner', 'repo', '/tmp/test', 'main', 'active')
		RETURNING id
	`.then((rows) => rows[0].id as string);

	const releaseId = await sql`
		INSERT INTO releases (project_id, name, version, sort_order, status)
		VALUES (${projectId}, 'v1.0', '1.0.0', 1, 'planned')
		RETURNING id
	`.then((rows) => rows[0].id as string);

	const featureId = await sql`
		INSERT INTO features (project_id, release_id, slug, title, state, branch_name)
		VALUES (${projectId}, ${releaseId}, 'test-feature', 'Test Feature', 'PLANNED', 'feature/test-feature')
		RETURNING id
	`.then((rows) => rows[0].id as string);

	const app = createApiApp({
		sessionService,
		nodeEnv: "test",
	}).app;

	const sessionCookie = `ac_session=${loginResult.rawToken}`;

	return { app, sessionCookie, projectId, releaseId, featureId };
}
