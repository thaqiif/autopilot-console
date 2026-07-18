/**
 * RED tests for single-administrator bootstrap auth, opaque sessions,
 * secure cookies, rate limiting, and CSRF (requirement 12).
 *
 * Uses isolated PostgreSQL + fake clock. No real HTTP framework required yet.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	applyCoreMigration,
	createDatabaseClient,
	type DatabaseClient,
	type Sql,
} from "../../../../packages/database/src/index";

// Modules under test — resolve fails / methods missing until Green.
import { bootstrapAdministrator } from "./admin-bootstrap";
import {
	createCsrfToken,
	csrfCookieName,
	csrfHeaderName,
	isCsrfExemptPath,
	validateCsrf,
} from "./csrf";
import { LoginRateLimiter } from "./login-rate-limit";
import { hashPassword, verifyPassword } from "./password";
import {
	buildSessionCookie,
	clearSessionCookie,
	parseSessionCookie,
	sessionCookieName,
} from "./session-cookie";
import { createSessionService } from "./session-service";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

const STRONG_PASSWORD = "Bootstrap-Passw0rd!";
const WEAK_PASSWORD = "short";

let client: DatabaseClient;
let sql: Sql;

/** Mutable fake clock for rate-limit and expiry tests. */
function createClock(startMs = Date.parse("2026-07-18T00:00:00.000Z")) {
	let now = startMs;
	return {
		now: () => new Date(now),
		advanceMs: (ms: number) => {
			now += ms;
		},
		set: (iso: string) => {
			now = Date.parse(iso);
		},
	};
}

async function mustReject(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected operation to reject");
}

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
	await sql.unsafe("CREATE SCHEMA public");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO postgres");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO public");
	await applyCoreMigration(sql);
});

afterAll(async () => {
	await client.end();
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
});

describe("password hashing", () => {
	test("hashes with a modern algorithm and never returns plaintext", async () => {
		const hash = await hashPassword(STRONG_PASSWORD);
		expect(hash).not.toBe(STRONG_PASSWORD);
		expect(hash.toLowerCase()).toMatch(/argon2|scrypt|bcrypt/);
		expect(await verifyPassword(STRONG_PASSWORD, hash)).toBe(true);
		expect(await verifyPassword("wrong-password-1!", hash)).toBe(false);
	});

	test("rejects weak passwords before hashing", async () => {
		const err = await mustReject(() => hashPassword(WEAK_PASSWORD));
		expect(err.message.toLowerCase()).toMatch(/weak|short|strength|password/);
		expect(JSON.stringify(err)).not.toContain(WEAK_PASSWORD);
	});
});

describe("administrator bootstrap", () => {
	test("creates at most one administrator from validated bootstrap password", async () => {
		const first = await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
		expect(first.username).toBe("admin");
		expect(first.passwordHash).not.toContain(STRONG_PASSWORD);
		expect(first.passwordHash.toLowerCase()).toMatch(/argon2|scrypt|bcrypt/);

		// Idempotent re-bootstrap with same password does not create a second row.
		const second = await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
		expect(second.id).toBe(first.id);

		const count = await sql`SELECT count(*)::int AS n FROM admin_accounts`;
		expect(count[0]?.n).toBe(1);

		const raw = await sql`SELECT * FROM admin_accounts`;
		expect(JSON.stringify(raw)).not.toContain(STRONG_PASSWORD);
	});

	test("rejects weak bootstrap password and leaves no admin row", async () => {
		const err = await mustReject(() =>
			bootstrapAdministrator(sql, {
				username: "admin",
				bootstrapPassword: WEAK_PASSWORD,
			}),
		);
		expect(err.message.toLowerCase()).toMatch(/weak|short|strength|password/);
		const count = await sql`SELECT count(*)::int AS n FROM admin_accounts`;
		expect(count[0]?.n).toBe(0);
	});

	test("refuses a second distinct administrator username", async () => {
		await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
		const err = await mustReject(() =>
			bootstrapAdministrator(sql, {
				username: "other",
				bootstrapPassword: STRONG_PASSWORD,
			}),
		);
		expect(err.message.toLowerCase()).toMatch(/one|single|already|admin/);
		const count = await sql`SELECT count(*)::int AS n FROM admin_accounts`;
		expect(count[0]?.n).toBe(1);
	});

	test("bootstrap password rotation updates hash and revokes existing sessions", async () => {
		const clock = createClock();
		const admin = await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
		const sessions = createSessionService({ sql, now: clock.now });
		const login = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		expect(login.ok).toBe(true);
		if (!login.ok) throw new Error("login failed");

		const rotated = await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: "New-Bootstrap-Passw0rd!",
			rotatePassword: true,
		});
		expect(rotated.id).toBe(admin.id);
		expect(rotated.passwordHash).not.toBe(admin.passwordHash);

		const resolved = await sessions.resolve({ rawToken: login.rawToken });
		expect(resolved).toBeNull();

		const oldLogin = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		expect(oldLogin.ok).toBe(false);

		const newLogin = await sessions.login({
			username: "admin",
			password: "New-Bootstrap-Passw0rd!",
		});
		expect(newLogin.ok).toBe(true);
	});
});

describe("session service", () => {
	async function seededAdmin() {
		return bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
	}

	test("successful login returns opaque raw token and stores only a hash/verifier", async () => {
		await seededAdmin();
		const clock = createClock();
		const sessions = createSessionService({ sql, now: clock.now });

		const result = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("login failed");

		expect(result.rawToken.length).toBeGreaterThanOrEqual(32);
		expect(result.session.tokenHash).not.toBe(result.rawToken);
		expect(result.session.tokenHash.length).toBeGreaterThan(16);
		expect(result.session.revokedAt).toBeNull();
		expect(result.session.expiresAt.getTime()).toBeGreaterThan(clock.now().getTime());

		const rows = await sql`SELECT token_hash FROM sessions`;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.token_hash).toBe(result.session.tokenHash);
		expect(JSON.stringify(rows)).not.toContain(result.rawToken);
	});

	test("failed login does not leak whether username or password mismatched", async () => {
		await seededAdmin();
		const sessions = createSessionService({ sql, now: () => new Date() });

		const badUser = await sessions.login({
			username: "nobody",
			password: STRONG_PASSWORD,
		});
		const badPass = await sessions.login({
			username: "admin",
			password: "Wrong-Password-1!",
		});
		expect(badUser.ok).toBe(false);
		expect(badPass.ok).toBe(false);
		if (badUser.ok || badPass.ok) throw new Error("expected failures");
		expect(badUser.message).toBe(badPass.message);
		expect(badUser.message.toLowerCase()).not.toMatch(/username|user not|unknown user/);
		expect(JSON.stringify(badUser)).not.toContain(STRONG_PASSWORD);
		expect(JSON.stringify(badPass)).not.toContain("Wrong-Password-1!");
	});

	test("resolve accepts live sessions and rejects expired or revoked ones", async () => {
		await seededAdmin();
		const clock = createClock();
		const sessions = createSessionService({
			sql,
			now: clock.now,
			ttlMs: 60_000,
		});

		const login = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		if (!login.ok) throw new Error("login failed");

		const live = await sessions.resolve({ rawToken: login.rawToken });
		expect(live?.session.id).toBe(login.session.id);
		expect(live?.admin.username).toBe("admin");

		clock.advanceMs(61_000);
		const expired = await sessions.resolve({ rawToken: login.rawToken });
		expect(expired).toBeNull();

		// Fresh login then explicit revoke
		clock.set("2026-07-18T01:00:00.000Z");
		const again = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		if (!again.ok) throw new Error("login failed");
		await sessions.revoke({ sessionId: again.session.id });
		const revoked = await sessions.resolve({ rawToken: again.rawToken });
		expect(revoked).toBeNull();
	});

	test("logout revokes the session immediately", async () => {
		await seededAdmin();
		const sessions = createSessionService({ sql, now: () => new Date() });
		const login = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		if (!login.ok) throw new Error("login failed");

		await sessions.logout({ rawToken: login.rawToken });
		const resolved = await sessions.resolve({ rawToken: login.rawToken });
		expect(resolved).toBeNull();

		const row = await sql`SELECT revoked_at FROM sessions WHERE id = ${login.session.id}`;
		expect(row[0]?.revoked_at).not.toBeNull();
	});

	test("each successful login issues a new rotated token", async () => {
		await seededAdmin();
		const sessions = createSessionService({ sql, now: () => new Date() });
		const a = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		const b = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		if (!a.ok || !b.ok) throw new Error("login failed");
		expect(a.rawToken).not.toBe(b.rawToken);
		expect(a.session.tokenHash).not.toBe(b.session.tokenHash);
	});
});

describe("session cookie", () => {
	test("production cookie is HttpOnly, SameSite=Strict, Secure, constrained path", () => {
		const cookie = buildSessionCookie({
			rawToken: "opaque-token-value-abcdefghijklmnopqrstuvwxyz",
			nodeEnv: "production",
			maxAgeSeconds: 3600,
		});
		const lower = cookie.toLowerCase();
		expect(cookie.startsWith(`${sessionCookieName()}=`)).toBe(true);
		expect(lower).toContain("httponly");
		expect(lower).toMatch(/samesite=strict/);
		expect(lower).toContain("secure");
		expect(lower).toMatch(/path=\//);
		expect(lower).not.toContain("opaque-token-value-abcdefghijklmnopqrstuvwxyz; Path=/*");
	});

	test("development cookie omits Secure but keeps HttpOnly and SameSite=Strict", () => {
		const cookie = buildSessionCookie({
			rawToken: "dev-token-abcdefghijklmnopqrstuvwxyz012345",
			nodeEnv: "development",
			maxAgeSeconds: 3600,
		});
		const lower = cookie.toLowerCase();
		expect(lower).toContain("httponly");
		expect(lower).toMatch(/samesite=strict/);
		expect(lower).not.toMatch(/(?:^|;)\s*secure(?:;|$)/);
	});

	test("clear cookie expires the session cookie", () => {
		const cleared = clearSessionCookie({ nodeEnv: "production" });
		const lower = cleared.toLowerCase();
		expect(cleared.startsWith(`${sessionCookieName()}=`)).toBe(true);
		expect(lower).toMatch(/max-age=0|expires=/);
		expect(lower).toContain("httponly");
	});

	test("parseSessionCookie extracts only the named cookie value", () => {
		const name = sessionCookieName();
		const header = `other=1; ${name}=secret-session-token; foo=bar`;
		expect(parseSessionCookie(header)).toBe("secret-session-token");
		expect(parseSessionCookie("foo=bar")).toBeNull();
		expect(parseSessionCookie(undefined)).toBeNull();
	});
});

describe("login rate limiting", () => {
	test("blocks after configured failures within window without leaking match details", async () => {
		await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
		const clock = createClock();
		const limiter = new LoginRateLimiter({
			maxAttempts: 3,
			windowMs: 60_000,
			now: clock.now,
		});
		const sessions = createSessionService({
			sql,
			now: clock.now,
			rateLimiter: limiter,
		});

		for (let i = 0; i < 3; i++) {
			const fail = await sessions.login({
				username: "admin",
				password: "Wrong-Password-1!",
				clientKey: "10.0.0.1",
			});
			expect(fail.ok).toBe(false);
			if (fail.ok) throw new Error("expected fail");
			expect(fail.code).not.toBe("RATE_LIMITED");
		}

		const limited = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
			clientKey: "10.0.0.1",
		});
		expect(limited.ok).toBe(false);
		if (limited.ok) throw new Error("expected limited");
		expect(limited.code).toBe("RATE_LIMITED");
		expect(limited.message.toLowerCase()).not.toMatch(/password|username/);

		// Different client key still allowed
		const other = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
			clientKey: "10.0.0.2",
		});
		expect(other.ok).toBe(true);

		// After window elapses, original client can try again
		clock.advanceMs(60_001);
		const after = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
			clientKey: "10.0.0.1",
		});
		expect(after.ok).toBe(true);
	});
});

describe("CSRF protection", () => {
	test("creates a double-submit token and accepts matching cookie + header", () => {
		const token = createCsrfToken();
		expect(token.length).toBeGreaterThanOrEqual(32);
		expect(csrfCookieName().length).toBeGreaterThan(0);
		expect(csrfHeaderName().length).toBeGreaterThan(0);

		const ok = validateCsrf({
			cookieToken: token,
			headerToken: token,
		});
		expect(ok).toBe(true);
	});

	test("rejects missing, mismatched, or empty CSRF evidence", () => {
		const token = createCsrfToken();
		expect(validateCsrf({ cookieToken: token, headerToken: "other" })).toBe(false);
		expect(validateCsrf({ cookieToken: token, headerToken: undefined })).toBe(false);
		expect(validateCsrf({ cookieToken: undefined, headerToken: token })).toBe(false);
		expect(validateCsrf({ cookieToken: "", headerToken: "" })).toBe(false);
	});

	test("login and health paths are documented as CSRF-exempt helpers", () => {
		// validateCsrf is for state-changing browser requests; callers skip it
		// for login/health. Export a small allowlist so middleware stays consistent.
		expect(isCsrfExemptPath("/api/auth/login")).toBe(true);
		expect(isCsrfExemptPath("/api/health")).toBe(true);
		expect(isCsrfExemptPath("/api/health/ready")).toBe(true);
		expect(isCsrfExemptPath("/api/projects")).toBe(false);
		expect(isCsrfExemptPath("/api/auth/logout")).toBe(false);
	});
});

describe("secret redaction in auth surfaces", () => {
	test("login failure and session objects never expose raw token or password fields in JSON", async () => {
		await bootstrapAdministrator(sql, {
			username: "admin",
			bootstrapPassword: STRONG_PASSWORD,
		});
		const sessions = createSessionService({ sql, now: () => new Date() });
		const fail = await sessions.login({
			username: "admin",
			password: "Wrong-Password-1!",
		});
		const blob = JSON.stringify(fail);
		expect(blob).not.toContain("Wrong-Password-1!");
		expect(blob).not.toContain(STRONG_PASSWORD);
		expect(blob.toLowerCase()).not.toMatch(/"password"\s*:/);

		const ok = await sessions.login({
			username: "admin",
			password: STRONG_PASSWORD,
		});
		if (!ok.ok) throw new Error("login failed");
		// Safe serialization of session row must not include raw token
		const sessionJson = JSON.stringify(ok.session);
		expect(sessionJson).not.toContain(ok.rawToken);
		expect(sessionJson).not.toMatch(/"rawToken"/);
	});
});
