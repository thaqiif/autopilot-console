/**
 * RED tests for the Hono API application boundary (requirement 21).
 *
 * Covers: default-deny route protection, public login/health, CSRF on
 * mutations, correlation ids, typed error envelopes, redacted health
 * dependencies, and a fixture that detects accidentally unprotected routes.
 *
 * Uses isolated PostgreSQL + fake clock. No real Autopilot/Git/GitHub effects.
 * Requests run in-process through the harness app (no network).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createIsolatedTestDatabase,
	createWorkspace,
	DATABASE_URL,
	type DatabaseClient,
	type Sql,
} from "../../../packages/database/src/index";
import { LoginRateLimiter } from "./auth/login-rate-limit";
import { createSessionService, type SessionService } from "./auth/session-service";
import { createProductionHealthProbes } from "./main";
import { type ApiTestHarness, type Clock, createApiTestHarness } from "./testing/api-fixture";

const ADMIN_USERNAME = "owner";
const ADMIN_PASSWORD = "Bootstrap-Passw0rd!";

let client: DatabaseClient;
let sql: Sql;
let harness: ApiTestHarness;
let sessionService: SessionService;
let clock: Clock;

/** Build an in-process request against the harness app. */
function call(
	method: string,
	path: string,
	init: { token?: string; headers?: Record<string, string>; json?: unknown } = {},
) {
	const headers: Record<string, string> = { ...(init.headers ?? {}) };
	if (init.token) headers.Cookie = `ac_session=${init.token}`;
	let body: string | undefined;
	if (init.json !== undefined) {
		body = JSON.stringify(init.json);
		headers["Content-Type"] = "application/json";
	}
	return harness.app.request(path, { method, headers, body });
}

async function authedClient(): Promise<{ token: string }> {
	const login = await harness.login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
	expect(login.ok).toBe(true);
	if (!login.ok) throw new Error("login failed");
	return { token: login.token };
}

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
	await sql.unsafe(`
		TRUNCATE TABLE
			audit_events,
			activity_events,
			sessions,
			admin_accounts,
			workspaces
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
	harness = await createApiTestHarness({
		sql,
		sessionService,
		now: clock.now,
	});
	await harness.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
});

describe("route protection (default-deny)", () => {
	test("rejects unauthenticated GET to a protected route with 401", async () => {
		const res = await call("GET", "/api/projects");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { ok: false; error: { code: string; nextAction: string } };
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(body.error.nextAction.length).toBeGreaterThan(0);
	});

	test("rejects unauthenticated POST mutation with 401", async () => {
		const res = await call("POST", "/api/projects", { json: { name: "x" } });
		expect(res.status).toBe(401);
	});

	test("rejects expired session", async () => {
		const { token } = await authedClient();
		// Advance past TTL (12h) so the session resolves as expired.
		clock.advanceMs(13 * 60 * 60 * 1000);
		const res = await call("GET", "/api/projects", { token });
		expect(res.status).toBe(401);
	});

	test("rejects an invalid session token", async () => {
		const res = await call("GET", "/api/projects", { token: "not-a-valid-session" });
		expect(res.status).toBe(401);
	});

	test("rejects a revoked session", async () => {
		const { token } = await authedClient();
		await sessionService.logout({ rawToken: token });
		const res = await call("GET", "/api/projects", { token });
		expect(res.status).toBe(401);
	});

	test("does not make unknown paths public merely because they share a public prefix", async () => {
		for (const path of ["/api/auth/login/probe", "/api/health/private"]) {
			const res = await call("GET", path);
			expect(res.status, path).toBe(401);
		}
	});

	test("allows authenticated request to protected route", async () => {
		const { token } = await authedClient();
		const res = await call("GET", "/api/projects", { token });
		expect(res.status).toBe(200);
	});
});

describe("public endpoints", () => {
	test("login succeeds with valid credentials and returns secure cookie", async () => {
		const login = await harness.login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
		expect(login.ok).toBe(true);
		if (!login.ok) return;
		expect(login.token.length).toBeGreaterThan(0);
		expect(login.setCookie).toContain("HttpOnly");
		expect(login.setCookie).toContain("SameSite=Strict");
		expect(login.setCookie).toContain("ac_session=");
	});

	test("login response body never exposes raw session token", async () => {
		const login = await harness.login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
		expect(login.ok).toBe(true);
		if (!login.ok) return;
		// Fetch the login response body to verify it doesn't leak the token
		const res = await call("POST", "/api/auth/login", {
			json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
		});
		const body = (await res.json()) as { ok: true; data: Record<string, unknown> };
		expect(body.data.authenticated).toBe(true);
		// The body must not contain the raw session token value
		expect(JSON.stringify(body.data)).not.toContain(login.token);
	});

	test("login fails with weak password before admin exists produces safe error", async () => {
		const res = await call("POST", "/api/auth/login", {
			json: { username: ADMIN_USERNAME, password: "nope" },
		});
		expect(res.status).toBe(401);
	});

	test("health endpoint is public and redacted", async () => {
		const res = await call("GET", "/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: true; data: unknown };
		expect(body.ok).toBe(true);
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("postgres");
		expect(raw).not.toContain("PASSWORD");
	});

	test("health endpoint reports all four required dependency components", async () => {
		const res = await call("GET", "/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: { database: unknown; worker: unknown; autopilot: unknown; github: unknown };
		};
		expect(body.data.database).toBeDefined();
		expect(body.data.worker).toBeDefined();
		expect(body.data.autopilot).toBeDefined();
		expect(body.data.github).toBeDefined();
	});

	test("health liveness endpoint is public and returns status", async () => {
		const res = await call("GET", "/api/health/live");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: true; data: { status: string; checkedAt: string } };
		expect(body.ok).toBe(true);
		expect(body.data.status).toBe("ok");
		expect(body.data.checkedAt).toBeDefined();
	});
});

describe("CSRF protection", () => {
	test("mutation without CSRF token is rejected for authenticated browser", async () => {
		const { token } = await authedClient();
		const res = await call("POST", "/api/projects", { token, json: { name: "New Project" } });
		expect(res.status).toBe(403);
	});

	test("mutation with matching double-submit token succeeds", async () => {
		const { token } = await authedClient();
		const csrf = await harness.issueCsrf(token);
		const res = await call("POST", "/api/projects", {
			token,
			headers: { "x-csrf-token": csrf },
			json: { name: "New Project" },
		});
		expect(res.status).not.toBe(403);
	});

	test("cross-origin browser mutation is rejected even with a valid CSRF token", async () => {
		const { token } = await authedClient();
		const csrf = await harness.issueCsrf(token);
		const res = await call("POST", "/api/projects", {
			token,
			headers: {
				Origin: "https://attacker.example",
				"x-csrf-token": csrf,
			},
			json: { name: "Cross-origin project" },
		});
		expect(res.status).toBe(403);
	});

	test("login mutation is CSRF-exempt", async () => {
		const res = await call("POST", "/api/auth/login", {
			json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
		});
		expect(res.status).not.toBe(403);
	});

	test("login still rejects cross-origin browser requests", async () => {
		const res = await call("POST", "/api/auth/login", {
			headers: { Origin: "https://attacker.example" },
			json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
		});
		expect(res.status).toBe(403);
	});
});

describe("correlation and error envelopes", () => {
	test("responses carry a correlation id", async () => {
		const res = await call("GET", "/api/health");
		expect(res.headers.get("x-correlation-id")).not.toBeNull();
	});

	test("unauthenticated errors include correlation id and typed envelope", async () => {
		const res = await call("GET", "/api/projects");
		expect(res.headers.get("x-correlation-id")).not.toBeNull();
		const body = (await res.json()) as {
			ok: false;
			error: { httpStatus: number; correlationId?: string };
		};
		expect(body.error.httpStatus).toBe(401);
		expect(body.error.correlationId).toBeDefined();
	});

	test("validation errors return 400 with nextAction guidance", async () => {
		const res = await call("POST", "/api/auth/login", {
			json: {},
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string; nextAction: string } };
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.nextAction.length).toBeGreaterThan(0);
	});

	test("failed login preserves the request correlation id", async () => {
		const res = await call("POST", "/api/auth/login", {
			headers: { "x-correlation-id": "http-login-failure" },
			json: { username: ADMIN_USERNAME, password: "Wrong-Password-1!" },
		});
		const body = (await res.json()) as { ok: false; error: { correlationId?: string } };
		expect(res.status).toBe(401);
		expect(body.error.correlationId).toBe("http-login-failure");
	});
});

describe("logout", () => {
	test("logout clears the session cookie and revokes server-side session", async () => {
		const { token } = await authedClient();
		const csrf = await harness.issueCsrf(token);
		const res = await call("POST", "/api/auth/logout", {
			token,
			headers: { "x-csrf-token": csrf },
		});
		expect(res.status).toBe(200);
		const clear = res.headers.get("set-cookie") ?? "";
		expect(clear).toContain("ac_session=");
		expect(clear).toContain("Max-Age=0");
		const after = await call("GET", "/api/projects", { token });
		expect(after.status).toBe(401);
	});
});

describe("route matrix completeness", () => {
	test("every non-public registered route requires a session or CSRF as appropriate", async () => {
		const matrix = harness.protectedRouteMatrix();
		expect(matrix.length).toBeGreaterThan(0);
		for (const route of matrix) {
			const res = await call(route.method, route.path);
			expect(res.status, `route ${route.method.toUpperCase()} ${route.path}`).toBe(401);
		}
	});
});

describe("production dependency health", () => {
	const healthyAutopilot = { validateRuntime: async () => ({ ok: true, message: "ok" }) };
	const healthyGithub = {
		validateAuthentication: async () => ({ ok: true, authenticated: true }),
		validateAccess: async () => ({
			ok: true,
			authenticated: true,
			repositoryReadable: true,
		}),
	};

	function probes(overrides?: {
		sql?: typeof sql;
		autopilot?: { validateRuntime: () => Promise<{ ok: boolean; message?: string }> };
		github?: {
			validateAuthentication: () => Promise<{ ok: boolean; authenticated: boolean }>;
			validateAccess: (input: {
				repository: { owner: string; repository: string; fullName: string };
				projectRoot: string;
			}) => Promise<{ ok: boolean; authenticated: boolean; repositoryReadable?: boolean }>;
		};
	}) {
		return createProductionHealthProbes(
			overrides?.sql ?? sql,
			overrides?.autopilot ?? healthyAutopilot,
			overrides?.github ?? healthyGithub,
		);
	}

	async function seedProject(values: {
		name: string;
		slug: string;
		owner?: string;
		repo?: string;
		path?: string;
	}) {
		await sql`DELETE FROM projects`;
		const workspace = await createWorkspace(sql);
		await sql`
			INSERT INTO projects (
				workspace_id, name, slug, github_owner, github_repo,
				canonical_path, development_branch
			) VALUES (
				${workspace.id},
				${values.name},
				${values.slug},
				${values.owner ?? "acme"},
				${values.repo ?? "widget"},
				${values.path ?? "/workspaces/widget"},
				'main'
			)
		`;
	}

	test("worker readiness reports heartbeat, capacity, active jobs, and available slots", async () => {
		await sql`DELETE FROM worker_registrations`;
		await sql`
			INSERT INTO worker_registrations (
				worker_id, hostname, capacity, active_jobs, last_heartbeat_at
			) VALUES ('worker-health', 'worker-host', 4, 2, now())
		`;
		const result = await probes().worker.check();
		expect(result.ok).toBe(true);
		expect(result.detail).toMatchObject({
			capacity: 4,
			activeJobs: 2,
			availableSlots: 2,
		});
		expect(result.detail?.lastHeartbeatAt).toBeDefined();
		// Bounded detail only — no credentials or raw adapter output.
		expect(JSON.stringify(result)).not.toMatch(/token|password|secret|gh\s/i);
	});

	test("worker readiness includes queue depth, oldest queued age, and polling lag", async () => {
		await sql`DELETE FROM worker_registrations`;
		await sql`
			INSERT INTO worker_registrations (
				worker_id, hostname, capacity, active_jobs, last_heartbeat_at
			) VALUES ('worker-queue-metrics', 'worker-host', 4, 1, now())
		`;
		const result = await probes().worker.check();
		expect(result.ok).toBe(true);
		expect(result.detail).toMatchObject({
			capacity: 4,
			activeJobs: 1,
		});
		// Production Settings contract (req 30): queue + polling lag share one
		// documented health detail shape with heartbeat/capacity fields.
		expect(typeof result.detail?.queueDepth).toBe("number");
		expect(typeof result.detail?.oldestQueuedAgeMs).toBe("number");
		expect(typeof result.detail?.pollingLagMs).toBe("number");
		expect(JSON.stringify(result)).not.toMatch(/token|password|secret/i);
	});

	test("worker readiness is unhealthy when no registration exists", async () => {
		await sql`DELETE FROM worker_registrations`;
		const result = await probes().worker.check();
		expect(result.ok).toBe(false);
		expect(result.detail).toMatchObject({
			active: false,
			capacity: 0,
			activeJobs: 0,
			availableSlots: 0,
			lastHeartbeatAt: null,
		});
	});

	test("worker readiness is unhealthy when the latest heartbeat is stale", async () => {
		await sql`DELETE FROM worker_registrations`;
		await sql`
			INSERT INTO worker_registrations (
				worker_id, hostname, capacity, active_jobs, last_heartbeat_at
			) VALUES (
				'worker-stale',
				'worker-host',
				4,
				1,
				now() - interval '2 minutes'
			)
		`;
		const result = await probes().worker.check();
		expect(result.ok).toBe(false);
		expect(result.detail).toMatchObject({
			active: false,
			capacity: 0,
			activeJobs: 0,
			availableSlots: 0,
		});
	});

	test("database readiness fails without leaking connection details", async () => {
		const failingSql = Object.assign(
			async () => {
				throw new Error("postgres://owner:s3cret@database/private");
			},
			{
				unsafe: async () => {
					throw new Error("postgres://owner:s3cret@database/private");
				},
			},
		) as unknown as typeof sql;
		const result = await probes({ sql: failingSql }).database.check();
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("s3cret");
		expect(JSON.stringify(result)).not.toContain("postgres://");
	});

	test("autopilot readiness fails when the runtime is unavailable", async () => {
		const result = await probes({
			autopilot: { validateRuntime: async () => ({ ok: false, message: "binary missing" }) },
		}).autopilot.check();
		expect(result.ok).toBe(false);
		expect(result.detail).toMatchObject({ available: false });
		expect(JSON.stringify(result)).not.toContain("binary missing");
	});

	test("GitHub readiness verifies authentication when no project is registered", async () => {
		await sql`DELETE FROM projects`;
		let authCalls = 0;
		let accessCalls = 0;
		const result = await probes({
			github: {
				validateAuthentication: async () => {
					authCalls += 1;
					return { ok: true, authenticated: true };
				},
				validateAccess: async () => {
					accessCalls += 1;
					return {
						ok: true,
						authenticated: true,
						repositoryReadable: true,
					};
				},
			},
		}).github.check();
		expect(result.ok).toBe(true);
		expect(result.detail).toMatchObject({
			authenticated: true,
			projectAvailable: false,
		});
		expect(authCalls).toBe(1);
		expect(accessCalls).toBe(0);
	});

	test("GitHub readiness is unhealthy when authentication fails with zero projects", async () => {
		await sql`DELETE FROM projects`;
		const result = await probes({
			github: {
				validateAuthentication: async () => ({ ok: false, authenticated: false }),
				validateAccess: async () => {
					throw new Error("validateAccess must not run without a project");
				},
			},
		}).github.check();
		expect(result.ok).toBe(false);
		expect(result.detail).toMatchObject({
			authenticated: false,
			projectAvailable: false,
		});
	});

	test("GitHub readiness reports repository access separately when a project exists", async () => {
		await seedProject({ name: "Health Project", slug: "health-project" });
		let accessCalls = 0;
		const result = await probes({
			github: {
				validateAuthentication: async () => ({ ok: true, authenticated: true }),
				validateAccess: async (input) => {
					accessCalls += 1;
					expect(input.repository.fullName).toBe("acme/widget");
					expect(input.projectRoot).toBe("/workspaces/widget");
					return {
						ok: false,
						authenticated: true,
						repositoryReadable: false,
					};
				},
			},
		}).github.check();
		expect(result.ok).toBe(false);
		expect(result.detail).toMatchObject({
			authenticated: true,
			projectAvailable: true,
			repositoryReadable: false,
		});
		expect(accessCalls).toBe(1);
	});

	test("GitHub readiness is healthy when project repository access succeeds", async () => {
		await seedProject({ name: "Healthy Repo", slug: "healthy-repo" });
		const result = await probes().github.check();
		expect(result.ok).toBe(true);
		expect(result.detail).toMatchObject({
			authenticated: true,
			projectAvailable: true,
			repositoryReadable: true,
		});
	});

	test("liveness stays ok when readiness dependencies are down", async () => {
		const { createHealthService } = await import("./health/health-service");
		const service = createHealthService({
			now: () => new Date("2026-07-19T00:00:00.000Z"),
			database: { name: "database", check: async () => ({ ok: false }) },
			worker: { name: "worker", check: async () => ({ ok: false }) },
			autopilot: { name: "autopilot", check: async () => ({ ok: false }) },
			github: { name: "github", check: async () => ({ ok: false }) },
		});

		expect(service.liveness()).toBe("ok");
		const readiness = await service.readiness();
		expect(readiness.status).not.toBe("ok");
	});
});

describe("isolated database harness", () => {
	test("concurrent API fixtures migrate and mutate independent schemas", async () => {
		const [first, second] = await Promise.all([
			createIsolatedTestDatabase(DATABASE_URL),
			createIsolatedTestDatabase(DATABASE_URL),
		]);
		try {
			await Promise.all([applyCoreMigration(first.sql), applyCoreMigration(second.sql)]);
			await Promise.all([
				first.sql`INSERT INTO workspaces (name) VALUES ('first')`,
				second.sql`INSERT INTO workspaces (name) VALUES ('second')`,
			]);
			const [[firstWorkspace], [secondWorkspace]] = await Promise.all([
				first.sql`SELECT name FROM workspaces`,
				second.sql`SELECT name FROM workspaces`,
			]);
			expect(firstWorkspace?.name).toBe("first");
			expect(secondWorkspace?.name).toBe("second");
		} finally {
			await Promise.all([first.end(), second.end()]);
		}
	});
});
