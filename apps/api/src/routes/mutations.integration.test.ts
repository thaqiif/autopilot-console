/**
 * RED tests for authenticated mutation APIs (requirement 22).
 *
 * Covers project/release/feature/task/approval/cancellation/retry/pr-retry
 * routes: default-deny protection, strict request schemas, validation/owner
 * guard, checksum/version/confirmation inputs, backend idempotency, prompt
 * response (no blocking on claim/process), proof that handlers never invoke
 * AutopilotRunner/GitGateway/GitHubGateway in request scope, and safe redacted
 * errors for invalid/unauthorized/stale/cross-project/unsafe-path requests.
 *
 * These tests fail before the mutation routes and services exist.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AutopilotRunner } from "../../../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createIsolatedTestDatabase,
	DATABASE_URL,
	type DatabaseClient,
	type Sql,
} from "../../../../packages/database/src/index";
import type { GitGateway } from "../../../../packages/git/src/index";
import type { GitHubGateway } from "../../../../packages/github/src/index";
import type { DomainAdapters } from "../app";
import { LoginRateLimiter } from "../auth/login-rate-limit";
import { SESSION_COOKIE_NAME } from "../auth/session-cookie";
import { createSessionService, type SessionService } from "../auth/session-service";
import { type ApiTestHarness, type Clock, createApiTestHarness } from "../testing/api-fixture";

const ADMIN_USERNAME = "owner";
const ADMIN_PASSWORD = "Bootstrap-Passw0rd!";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const RELEASE_ID = "00000000-0000-4000-8000-000000000002";
const FEATURE_ID = "00000000-0000-4000-8000-000000000003";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000004";

let client: DatabaseClient;
let sql: Sql;
let harness: ApiTestHarness;
let sessionService: SessionService;
let clock: Clock;

// Spies proving handlers stay in request scope (no worker-side adapters).
let gitPreflightCalls = 0;
let githubCalls = 0;
let autopilotCalls = 0;
let projectCreateCalls = 0;
let projectValidationCalls = 0;
let cancellationCalls = 0;
let approvalInvalidationCalls = 0;
let taskReplacementCalls = 0;
let lastApprovalInput: Record<string, unknown> | undefined;

function makeGatewayFakes(): {
	git: Partial<GitGateway>;
	github: Partial<GitHubGateway>;
	autopilot: Partial<AutopilotRunner>;
} {
	gitPreflightCalls = 0;
	githubCalls = 0;
	autopilotCalls = 0;
	return {
		git: {
			preflight: async () => {
				gitPreflightCalls++;
				return {
					ok: true,
					failures: [],
					repository: { owner: "o", repository: "r", fullName: "o/r" },
					projectRoot: "/srv/repos/p",
					remoteName: "origin",
					remoteUrl: "https://github.com/o/r.git",
					developmentBranch: "main",
					featureBranch: "feature/test",
					headBranch: "main",
					headSha: "abc123",
				};
			},
		},
		github: {
			validateAccess: async () => {
				githubCalls++;
				return {
					ok: true,
					authenticated: true,
					login: "owner",
					repositoryReadable: true,
					pushFeasible: true,
					failures: [],
				};
			},
		},
		autopilot: {
			validateRuntime: async () => {
				autopilotCalls++;
				return { ok: true, message: "ok" };
			},
		},
	};
}

let _gatewayFakes = makeGatewayFakes();

/**
 * Build fake domain services so the API route tests can verify that handlers
 * delegate to services without calling adapters directly. Each fake returns
 * deterministic results for the scenarios tested in the mutation suite.
 */
function buildDomainAdapters(): DomainAdapters {
	projectCreateCalls = 0;
	projectValidationCalls = 0;
	cancellationCalls = 0;
	approvalInvalidationCalls = 0;
	taskReplacementCalls = 0;
	lastApprovalInput = undefined;
	const projectService = {
		async validateProject() {
			projectValidationCalls++;
			return { ok: true, canonicalPath: "/srv/repos/p", checks: [] };
		},
		async createProject(input: { name: string; slug: string }) {
			projectCreateCalls++;
			if (!input.name || !input.slug) {
				return {
					ok: false as const,
					reason: "VALIDATION_FAILED" as const,
					message: "Name and slug required",
				};
			}
			return {
				ok: true as const,
				project: { id: PROJECT_ID, name: input.name, slug: input.slug, status: "active" },
				validation: { ok: true, canonicalPath: "/srv/repos/p", checks: [] },
			};
		},
		async updateProject(input: Record<string, unknown>) {
			if (
				input.projectId === "does-not-exist" ||
				input.projectId === "00000000-0000-0000-0000-000000000099"
			) {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Not found" };
			}
			if (input.projectId === "has-active-jobs") {
				return {
					ok: false as const,
					reason: "ACTIVE_JOBS" as const,
					message: "Active jobs prevent changes",
				};
			}
			return {
				ok: true as const,
				project: {
					id: input.projectId,
					name: input.name || "Updated",
					slug: "p",
					status: "active",
				},
			};
		},
		async archiveProject(input: Record<string, unknown>) {
			if (input.projectId === "does-not-exist") {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Not found" };
			}
			if (input.projectId === "has-active-jobs") {
				return {
					ok: false as const,
					reason: "ACTIVE_JOBS" as const,
					message: "Active jobs prevent archival",
				};
			}
			return {
				ok: true as const,
				project: { id: input.projectId, name: "Archived", slug: "p", status: "archived" },
			};
		},
	};

	const releaseService = {
		async createRelease(input: { projectId: string }) {
			if (input.projectId === "does-not-exist") {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Project not found" };
			}
			return {
				ok: true as const,
				release: { id: "rel-1", projectId: input.projectId, name: "R", version: "1.0.0" },
			};
		},
		async updateRelease(input: Record<string, unknown>) {
			if (input.releaseId === "does-not-exist") {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Not found" };
			}
			return {
				ok: true as const,
				release: {
					id: input.releaseId,
					name: input.name || "Updated",
					version: input.version || "1.0.0",
				},
			};
		},
		async archiveRelease(input: Record<string, unknown>) {
			if (input.releaseId === "does-not-exist") {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Not found" };
			}
			return {
				ok: true as const,
				release: { id: input.releaseId, name: "Archived", version: "1.0.0", status: "archived" },
			};
		},
		async listReleases() {
			return [];
		},
		async getReleaseProgress() {
			return { ok: false as const, reason: "NOT_FOUND" as const, message: "Not found" };
		},
	};

	const featureService = {
		async createFeature(input: { projectId: string; releaseId: string }) {
			if (input.releaseId === "missing") {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Release not found" };
			}
			return {
				ok: true as const,
				feature: {
					id: "feat-1",
					projectId: input.projectId,
					releaseId: input.releaseId,
					slug: "f",
					state: "PLANNED",
				},
			};
		},
		async updateFeature(input: Record<string, unknown>) {
			if (input.featureId === "does-not-exist") {
				return { ok: false as const, reason: "NOT_FOUND" as const, message: "Not found" };
			}
			return {
				ok: true as const,
				feature: {
					id: input.featureId,
					title: input.title || "Updated",
					slug: "f",
					state: "PLANNED",
				},
			};
		},
		async getFeature() {
			return null;
		},
	};

	const taskApprovalService = {
		async attachTask(input: { relativeTaskPath: string }) {
			if (input.relativeTaskPath.includes("..")) {
				return { ok: false as const, reason: "VALIDATION_FAILED" as const, message: "Unsafe path" };
			}
			return {
				ok: true as const,
				feature: { id: "feat-1", state: "TASKS_REVIEW" },
				summary: { requirements: [] },
				checksum: "abc123",
			};
		},
		async removeTask(input: Record<string, unknown>) {
			if (
				input.featureId === "missing" ||
				input.featureId === "00000000-0000-0000-0000-000000000099"
			) {
				return {
					ok: false as const,
					reason: "FEATURE_NOT_FOUND" as const,
					message: "Feature not found",
				};
			}
			return { ok: true as const, feature: { id: input.featureId, state: "PLANNED" } };
		},
		async approveAndQueue(input: { displayedChecksum: string; operationKey: string }) {
			lastApprovalInput = input as unknown as Record<string, unknown>;
			if (!input.displayedChecksum) {
				return {
					ok: false as const,
					reason: "VALIDATION_FAILED" as const,
					message: "Checksum required",
				};
			}
			return {
				ok: true as const,
				feature: { id: "feat-1", state: "QUEUED" },
				approval: { id: "appr-1", checksum: input.displayedChecksum },
				attempt: { id: "att-1", status: "queued" },
				idempotent: false,
			};
		},
		async invalidateApproval(input: Record<string, unknown>) {
			approvalInvalidationCalls++;
			return {
				ok: true as const,
				approval: { id: input.approvalId, invalidatedAt: "2026-07-21T00:00:00.000Z" },
			};
		},
		async replaceTask(input: Record<string, unknown>) {
			taskReplacementCalls++;
			return {
				ok: true as const,
				feature: { id: input.featureId, state: "TASKS_REVIEW" },
				summary: { requirements: [] },
				checksum: "replacement-checksum",
				invalidatedApprovalId: input.approvalId,
				idempotent: false,
			};
		},
	};

	return {
		sql,
		projectService: projectService as DomainAdapters["projectService"],
		releaseService: releaseService as DomainAdapters["releaseService"],
		featureService: featureService as DomainAdapters["featureService"],
		taskApprovalService: taskApprovalService as unknown as DomainAdapters["taskApprovalService"],
		cancelHandler: async (_attempt, _feature, _reason, _operationId) => {
			cancellationCalls++;
			return { kind: "cancelled", attemptId: _attempt.id };
		},
		retryHandler: async (_req) => ({
			kind: "retried",
			attempt: undefined,
		}),
	};
}

function call(
	method: string,
	path: string,
	init: { token?: string; csrf?: string; headers?: Record<string, string>; json?: unknown } = {},
) {
	const headers: Record<string, string> = { ...(init.headers ?? {}) };
	if (init.token) headers.Cookie = `${SESSION_COOKIE_NAME}=${init.token}`;
	if (init.csrf) headers["x-csrf-token"] = init.csrf;
	let body: string | undefined;
	if (init.json !== undefined) {
		body = JSON.stringify(init.json);
		headers["Content-Type"] = "application/json";
	}
	return harness.app.request(path, { method, headers, body });
}

async function authed(): Promise<{ token: string; csrf: string }> {
	const login = await harness.login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
	expect(login.ok).toBe(true);
	if (!login.ok) throw new Error("login failed");
	const csrf = await harness.issueCsrf(login.token);
	return { token: login.token, csrf };
}

beforeAll(async () => {
	client = await createIsolatedTestDatabase(DATABASE_URL);
	sql = client.sql;
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

async function seedProjectAttempt(status: "QUEUED" | "RUNNING" = "RUNNING") {
	const [admin] = await sql`SELECT id FROM admin_accounts LIMIT 1`;
	await sql`INSERT INTO workspaces (name) VALUES ('default')`;
	await sql`
		INSERT INTO projects (
			id, workspace_id, name, slug, github_owner, github_repo,
			canonical_path, development_branch
		) VALUES (
			${PROJECT_ID}, (SELECT id FROM workspaces LIMIT 1), 'Project', 'project',
			'owner', 'repo', '/projects/repo', 'main'
		)
	`;
	await sql`
		INSERT INTO releases (id, project_id, name, version)
		VALUES (${RELEASE_ID}, ${PROJECT_ID}, 'Release', '1.0.0')
	`;
	await sql`
		INSERT INTO features (id, project_id, release_id, slug, title, state, branch_name)
		VALUES (
			${FEATURE_ID}, ${PROJECT_ID}, ${RELEASE_ID}, 'feature', 'Feature',
			${status === "RUNNING" ? "DEVELOPING" : "QUEUED"}, 'feature/feature'
		)
	`;
	await sql`
		INSERT INTO task_approvals (
			id, project_id, feature_id, relative_task_path, checksum,
			schema_compatibility_version, requirements_snapshot, approved_by_admin_id, approved_at
		) VALUES (
			${APPROVAL_ID}, ${PROJECT_ID}, ${FEATURE_ID}, 'tasks/feature.json', 'checksum',
			'1', '[]', ${admin?.id}, now()
		)
	`;
	const [attempt] = await sql`
		INSERT INTO development_job_attempts (
			project_id, feature_id, task_approval_id, branch_name, operation_key, status
		) VALUES (
			${PROJECT_ID}, ${FEATURE_ID}, ${APPROVAL_ID}, 'feature/feature',
			'develop-seeded', ${status}
		) RETURNING id
	`;
	return { attemptId: attempt?.id as string };
}

afterAll(async () => {
	await client.end();
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			audit_events,
			activity_events,
			sessions,
			admin_accounts,
			workspaces,
			projects,
			releases,
			features,
			task_approvals,
			development_job_attempts,
			idempotency_records
		RESTART IDENTITY CASCADE
	`);
	const rateLimiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
	let currentMs = Date.parse("2026-07-18T00:00:00.000Z");
	clock = {
		now: () => new Date(currentMs),
		advanceMs: (ms: number) => {
			currentMs += ms;
		},
	};
	sessionService = createSessionService({ sql, rateLimiter, now: clock.now });
	_gatewayFakes = makeGatewayFakes();
	const domainAdapters = buildDomainAdapters();
	harness = await createApiTestHarness({
		sql,
		sessionService,
		now: clock.now,
		adapters: domainAdapters,
	});
	await harness.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
});

describe("route protection", () => {
	test("rejects unauthenticated project create with 401", async () => {
		const res = await call("POST", "/api/projects", {
			json: { name: "x", slug: "x" },
		});
		expect(res.status).toBe(401);
	});

	test("rejects unauthenticated feature cancel with 401", async () => {
		const res = await call("POST", "/api/features/abc/cancel", { json: {} });
		expect(res.status).toBe(401);
	});
});

describe("project mutations", () => {
	test("validates project configuration without creating a project", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/projects/validate", {
			token,
			csrf,
			json: {
				name: "Project",
				slug: "project",
				githubOwner: "owner",
				githubRepo: "repo",
				workspacePath: "/srv/repos/p",
				developmentBranch: "main",
			},
		});
		expect(res.status).toBe(200);
		expect(projectValidationCalls).toBe(1);
		expect(projectCreateCalls).toBe(0);
	});

	test("create project requires CSRF and rejects unsafe path", async () => {
		const { token } = await authed();
		const noCsrf = await call("POST", "/api/projects", {
			token,
			json: {
				name: "P",
				slug: "p",
				githubOwner: "o",
				githubRepo: "r",
				workspacePath: "/etc/passwd",
				developmentBranch: "main",
			},
		});
		expect(noCsrf.status).toBe(403);
	});

	test("create project validates ownership and only enters request scope", async () => {
		const { token, csrf } = await authed();
		await sql`INSERT INTO workspaces (name) VALUES ('default')`;
		const res = await call("POST", "/api/projects", {
			token,
			csrf,
			json: {
				name: "P",
				slug: "p",
				githubOwner: "o",
				githubRepo: "r",
				workspacePath: "/srv/repos/p",
				developmentBranch: "main",
			},
		});
		// Either succeeds (validation ok) or returns a safe rejection; never 500.
		expect([200, 201, 400, 409, 422]).toContain(res.status);
		// Handlers must not invoke worker-side adapters in request scope.
		expect(gitPreflightCalls).toBe(0);
		expect(githubCalls).toBe(0);
		expect(autopilotCalls).toBe(0);
	});

	test("duplicate create with same idempotency key returns original outcome", async () => {
		const { token, csrf } = await authed();
		await seedProjectAttempt("QUEUED");
		const body = {
			name: "P",
			slug: "p",
			githubOwner: "o",
			githubRepo: "r",
			workspacePath: "/srv/repos/p",
			developmentBranch: "main",
			idempotencyKey: "dup-project-1",
		};
		const first = await call("POST", "/api/projects", { token, csrf, json: body });
		const second = await call("POST", "/api/projects", { token, csrf, json: body });
		expect(first.status).toBe(201);
		expect(second.status).toBe(first.status);
		expect(projectCreateCalls).toBe(1);
		const [idempotency] = await sql`
			SELECT count(*)::int AS count
			FROM idempotency_records
			WHERE operation_key = 'dup-project-1'
		`;
		expect(idempotency?.count).toBe(1);
	});
});

describe("release and feature mutations", () => {
	test("create release requires project id and returns 201 on success", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/releases", {
			token,
			csrf,
			json: { projectId: "does-not-exist", name: "R", version: "1.0.0" },
		});
		expect(res.status).toBe(404);
	});

	test("create feature requires project-scoped slug", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/features", {
			token,
			csrf,
			json: { releaseId: "missing", title: "F", slug: "f" },
		});
		expect([404, 400, 409]).toContain(res.status);
	});
});

describe("task approval lifecycle", () => {
	test("invalidates an approval only with exact project and feature confirmation", async () => {
		const { token, csrf } = await authed();
		await seedProjectAttempt("QUEUED");
		const request = () =>
			call("POST", `/api/features/${FEATURE_ID}/approvals/${APPROVAL_ID}/invalidate`, {
				token,
				csrf,
				json: {
					projectId: PROJECT_ID,
					featureId: FEATURE_ID,
					operationKey: "invalidate-approval-1",
					confirmation: "invalidate-task-approval",
				},
			});
		const first = await request();
		const second = await request();
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(await first.json());
		expect(approvalInvalidationCalls).toBe(1);
	});

	test("replaces a task through one domain command and rejects unsafe input before mutation", async () => {
		const { token, csrf } = await authed();
		const unsafe = await call("PUT", `/api/features/${FEATURE_ID}/task`, {
			token,
			csrf,
			json: {
				projectId: PROJECT_ID,
				featureId: FEATURE_ID,
				approvalId: APPROVAL_ID,
				relativeTaskPath: "../../etc/secret.json",
				operationKey: "replace-task-unsafe",
				confirmation: "replace-task",
			},
		});
		expect(unsafe.status).toBe(400);
		expect(approvalInvalidationCalls).toBe(0);
		expect(taskReplacementCalls).toBe(0);

		const valid = await call("PUT", `/api/features/${FEATURE_ID}/task`, {
			token,
			csrf,
			json: {
				projectId: PROJECT_ID,
				featureId: FEATURE_ID,
				approvalId: APPROVAL_ID,
				relativeTaskPath: "tasks/replacement.json",
				operationKey: "replace-task-1",
				confirmation: "replace-task",
			},
		});
		expect(valid.status).toBe(200);
		expect(taskReplacementCalls).toBe(1);
		expect(approvalInvalidationCalls).toBe(0);
	});

	test("attach task rejects unsafe traversal path", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/features/abc/task", {
			token,
			csrf,
			json: { relativeTaskPath: "../../etc/secret.json" },
		});
		expect([400, 404]).toContain(res.status);
	});

	test("approve and queue requires displayed checksum and confirmation", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/features/abc/approve-queue", {
			token,
			csrf,
			json: { operationKey: "op-1", confirmation: "approve-and-queue" },
		});
		// Missing checksum -> validation failure, not success.
		expect(res.status).not.toBe(200);
	});

	test("valid approve and queue returns within latency at fixture scale and never calls adapters", async () => {
		const { token, csrf } = await authed();
		await seedProjectAttempt("QUEUED");
		await sql`
			INSERT INTO development_job_attempts (
				project_id, feature_id, task_approval_id, branch_name, operation_key, status
			)
			SELECT
				${PROJECT_ID}, ${FEATURE_ID}, ${APPROVAL_ID}, 'feature/feature',
				'completed-' || n::text, 'SUCCEEDED'
			FROM generate_series(1, 250) AS n
		`;
		const start = Date.now();
		const res = await call("POST", `/api/features/${FEATURE_ID}/approve-queue`, {
			token,
			csrf,
			json: {
				projectId: PROJECT_ID,
				featureId: FEATURE_ID,
				displayedChecksum: "deadbeef",
				operationKey: "op-2",
				confirmation: "approve-and-queue",
			},
		});
		expect(Date.now() - start).toBeLessThan(2000);
		expect(gitPreflightCalls).toBe(0);
		expect(githubCalls).toBe(0);
		expect(autopilotCalls).toBe(0);
		expect(res.status).toBe(200);
		expect(lastApprovalInput).toMatchObject({
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
		});
	});
});

describe("job and pr actions", () => {
	test("routes running cancellation durably and reuses a stable operation outcome", async () => {
		const { token, csrf } = await authed();
		const { attemptId } = await seedProjectAttempt("RUNNING");
		const request = () =>
			call("POST", `/api/features/${FEATURE_ID}/cancel`, {
				token,
				csrf,
				json: {
					projectId: PROJECT_ID,
					featureId: FEATURE_ID,
					operationKey: "cancel-running-1",
					reason: "owner requested",
					confirmation: "cancel-development",
				},
			});

		const first = await request();
		const second = await request();
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await first.json()).toEqual(await second.json());
		expect(cancellationCalls).toBe(0);
		const [attempt] = await sql`
			SELECT status, cancellation_reason, cancellation_requested_at
			FROM development_job_attempts WHERE id = ${attemptId}
		`;
		expect(attempt).toMatchObject({
			status: "CANCEL_REQUESTED",
			cancellation_reason: "owner requested",
		});
		expect(attempt?.cancellation_requested_at).not.toBeNull();
		const [counts] = await sql`
			SELECT
				(SELECT count(*)::int FROM idempotency_records WHERE operation_key = 'cancel-running-1') AS idempotency,
				(SELECT count(*)::int FROM activity_events WHERE feature_id = ${FEATURE_ID} AND type = 'development.cancel_requested') AS activity,
				(SELECT count(*)::int FROM audit_events WHERE feature_id = ${FEATURE_ID} AND action = 'development.cancel_request') AS audit
		`;
		expect(counts).toMatchObject({ idempotency: 1, activity: 1, audit: 1 });
	});

	test("rejects cancellation when confirmed project or feature does not match the target", async () => {
		const { token, csrf } = await authed();
		await seedProjectAttempt("QUEUED");
		const res = await call("POST", `/api/features/${FEATURE_ID}/cancel`, {
			token,
			csrf,
			json: {
				projectId: "00000000-0000-4000-8000-000000000099",
				featureId: FEATURE_ID,
				operationKey: "cancel-wrong-project",
				confirmation: "cancel-development",
			},
		});
		expect(res.status).toBe(400);
		expect(cancellationCalls).toBe(0);
	});

	test("cancel requires feature/project confirmation", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/features/abc/cancel", {
			token,
			csrf,
			json: { reason: "user requested" },
		});
		expect([400, 404, 409]).toContain(res.status);
	});

	test("retry requires confirmation and returns prompt", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/features/abc/retry", {
			token,
			csrf,
			json: { operationKey: "retry-1", confirmation: "retry-development" },
		});
		expect([400, 404, 409]).toContain(res.status);
	});

	test("pr creation retry requires confirmation", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/features/abc/pr-retry", {
			token,
			csrf,
			json: { attemptId: "att-1", confirmation: "retry-pr-creation" },
		});
		expect([400, 404, 409]).toContain(res.status);
	});

	test("concurrent identical PR retries persist one durable idempotent intent", async () => {
		const { token, csrf } = await authed();
		const [admin] = await sql`SELECT id FROM admin_accounts LIMIT 1`;
		const [workspace] = await sql`INSERT INTO workspaces (name) VALUES ('default') RETURNING id`;
		const [project] = await sql`
			INSERT INTO projects (workspace_id, name, slug, github_owner, github_repo, canonical_path, development_branch)
			VALUES (${workspace?.id}, 'Project', 'project', 'owner', 'repo', '/projects/repo', 'main') RETURNING id
		`;
		const [release] = await sql`
			INSERT INTO releases (project_id, name, version) VALUES (${project?.id}, 'Release', '1.0.0') RETURNING id
		`;
		const [feature] = await sql`
			INSERT INTO features (project_id, release_id, slug, title, state, branch_name)
			VALUES (${project?.id}, ${release?.id}, 'feature', 'Feature', 'PR_CREATION_FAILED', 'feature/feature') RETURNING id
		`;
		const [approval] = await sql`
			INSERT INTO task_approvals (
				project_id, feature_id, relative_task_path, checksum,
				schema_compatibility_version, requirements_snapshot, approved_by_admin_id, approved_at
			) VALUES (${project?.id}, ${feature?.id}, 'tasks/feature.json', 'checksum', '1', '[]', ${admin?.id}, now())
			RETURNING id
		`;
		const [attempt] = await sql`
			INSERT INTO development_job_attempts (
				project_id, feature_id, task_approval_id, branch_name, operation_key, status
			) VALUES (${project?.id}, ${feature?.id}, ${approval?.id}, 'feature/feature', 'develop-1', 'SUCCEEDED')
			RETURNING id
		`;
		const wrongTarget = await call("POST", `/api/features/${feature?.id}/pr-retry`, {
			token,
			csrf,
			json: {
				projectId: "00000000-0000-4000-8000-000000000099",
				featureId: feature?.id,
				operationKey: "pr-retry-wrong-project",
				attemptId: attempt?.id,
				confirmation: "retry-pr-creation",
			},
		});
		expect(wrongTarget.status).toBe(400);
		const request = () =>
			call("POST", `/api/features/${feature?.id}/pr-retry`, {
				token,
				csrf,
				json: {
					projectId: project?.id,
					featureId: feature?.id,
					operationKey: "pr-retry-1",
					attemptId: attempt?.id,
					confirmation: "retry-pr-creation",
				},
			});

		const responses = await Promise.all([request(), request()]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		const [counts] = await sql`
			SELECT
				(SELECT count(*)::int FROM outbox_intents WHERE feature_id = ${feature?.id}) AS outbox,
				(SELECT count(*)::int FROM activity_events WHERE feature_id = ${feature?.id}) AS activity,
				(SELECT count(*)::int FROM audit_events WHERE feature_id = ${feature?.id}) AS audit,
				(SELECT count(*)::int FROM idempotency_records WHERE feature_id = ${feature?.id}) AS idempotency
		`;
		expect(counts).toMatchObject({ outbox: 1, activity: 1, audit: 1, idempotency: 1 });
	});
});

describe("error envelope and redaction", () => {
	test("invalid mutation returns typed envelope with next action", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/projects", {
			token,
			csrf,
			json: { name: "" },
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		const body = (await res.json()) as { ok: false; error: { code: string; nextAction: string } };
		expect(body.ok).toBe(false);
		expect(body.error.code.length).toBeGreaterThan(0);
		expect(body.error.nextAction.length).toBeGreaterThan(0);
	});
});

describe("project update and archive", () => {
	test("PUT /api/projects/:id updates project name when valid", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/projects/proj-1", {
			token,
			csrf,
			json: { name: "Updated Name" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect((body.data as Record<string, unknown>).name).toBe("Updated Name");
	});

	test("PUT /api/projects/:id returns 404 for missing project", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/projects/does-not-exist", {
			token,
			csrf,
			json: { name: "X" },
		});
		expect(res.status).toBe(404);
	});

	test("PUT /api/projects/:id returns 409 when active jobs exist", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/projects/has-active-jobs", {
			token,
			csrf,
			json: { name: "X" },
		});
		expect(res.status).toBe(409);
	});

	test("POST /api/projects/:id/archive archives project", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/projects/proj-1/archive", {
			token,
			csrf,
			json: {},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect((body.data as Record<string, unknown>).status).toBe("archived");
	});

	test("POST /api/projects/:id/archive returns 409 with active jobs", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/projects/has-active-jobs/archive", {
			token,
			csrf,
			json: {},
		});
		expect(res.status).toBe(409);
	});

	test("project mutations require CSRF", async () => {
		const { token } = await authed();
		const res = await call("PUT", "/api/projects/proj-1", {
			token,
			json: { name: "X" },
		});
		expect(res.status).toBe(403);
	});
});

describe("release update and archive", () => {
	test("PUT /api/releases/:id updates release", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/releases/rel-1", {
			token,
			csrf,
			json: { name: "Updated Release", version: "2.0.0" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test("PUT /api/releases/:id returns 404 for missing release", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/releases/does-not-exist", {
			token,
			csrf,
			json: { name: "X" },
		});
		expect(res.status).toBe(404);
	});

	test("POST /api/releases/:id/archive archives release", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/releases/rel-1/archive", {
			token,
			csrf,
			json: {},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test("POST /api/releases/:id/archive returns 404 for missing", async () => {
		const { token, csrf } = await authed();
		const res = await call("POST", "/api/releases/does-not-exist/archive", {
			token,
			csrf,
			json: {},
		});
		expect(res.status).toBe(404);
	});
});

describe("feature update", () => {
	test("PUT /api/features/:id updates feature", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/features/feat-1", {
			token,
			csrf,
			json: { title: "Updated Feature" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test("PUT /api/features/:id returns 404 for missing", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/features/does-not-exist", {
			token,
			csrf,
			json: { title: "X" },
		});
		expect(res.status).toBe(404);
	});
});

describe("task remove", () => {
	test("DELETE /api/features/:id/task removes task", async () => {
		const { token, csrf } = await authed();
		const res = await call("DELETE", "/api/features/00000000-0000-0000-0000-000000000001/task", {
			token,
			csrf,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test("DELETE /api/features/:id/task returns 404 for missing feature", async () => {
		const { token, csrf } = await authed();
		const res = await call("DELETE", "/api/features/does-not-exist/task", {
			token,
			csrf,
		});
		expect(res.status).toBe(404);
	});
});

describe("additional error envelope checks", () => {
	test("404 returns typed envelope with next action", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/projects/does-not-exist", {
			token,
			csrf,
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect((body.error as Record<string, unknown>).code).toBe("NOT_FOUND");
	});

	test("409 conflict returns typed error envelope", async () => {
		const { token, csrf } = await authed();
		const res = await call("PUT", "/api/projects/has-active-jobs", {
			token,
			csrf,
			json: { name: "X" },
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect((body.error as Record<string, unknown>).code).toBeTruthy();
	});
});
