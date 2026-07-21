import { describe, expect, mock, test } from "bun:test";
import type { AdminAccountRow, SessionRow } from "../../../../packages/database/src/index";
import { createApiApp } from "../app";
import type { SessionService } from "../auth/session-service";
import { createCsrfProtector } from "../security/csrf-protector";

const RAW_TOKEN = "server-session-token";

function fakeSessionService(): SessionService {
	const admin = { id: "admin-1", username: "owner" } as AdminAccountRow;
	const session = { id: "session-1", adminAccountId: admin.id } as SessionRow;
	return {
		login: async () => ({ ok: true, rawToken: RAW_TOKEN, admin, session }),
		resolve: async ({ rawToken }) => (rawToken === RAW_TOKEN ? { admin, session } : null),
		logout: async () => undefined,
		revoke: async () => undefined,
	};
}

describe("authentication HTTP contract", () => {
	test("login returns a session-bound CSRF token without exposing the session token", async () => {
		const { app } = createApiApp({
			sessionService: fakeSessionService(),
			nodeEnv: "test",
		});
		const response = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }),
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: true;
			data: { authenticated: boolean; csrfToken?: string };
		};
		expect(body.data.authenticated).toBe(true);
		expect(body.data.csrfToken?.length).toBeGreaterThan(20);
		expect(JSON.stringify(body)).not.toContain(RAW_TOKEN);
	});

	test("session restores the authenticated owner and refreshes CSRF", async () => {
		const { app } = createApiApp({
			sessionService: fakeSessionService(),
			nodeEnv: "test",
		});
		const response = await app.request("/api/auth/session", {
			headers: { cookie: `ac_session=${RAW_TOKEN}` },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			data: {
				authenticated: true,
				username: "owner",
				csrfToken: expect.any(String),
			},
		});
	});

	test("logout revokes both the server session and its CSRF token", async () => {
		const service = fakeSessionService();
		const logout = mock(service.logout);
		service.logout = logout;
		const csrf = createCsrfProtector();
		const csrfToken = csrf.issue(RAW_TOKEN);
		const { app } = createApiApp({ sessionService: service, csrf, nodeEnv: "test" });

		const response = await app.request("/api/auth/logout", {
			method: "POST",
			headers: {
				cookie: `ac_session=${RAW_TOKEN}`,
				"x-csrf-token": csrfToken,
			},
		});

		expect(response.status).toBe(200);
		expect(logout).toHaveBeenCalledWith({ rawToken: RAW_TOKEN });
		expect(
			csrf.validate({
				sessionCookie: `ac_session=${RAW_TOKEN}`,
				csrfCookie: null,
				csrfHeader: csrfToken,
			}),
		).toBe(false);
	});

	test("authentication failures never log cookies or raw session tokens", async () => {
		const service = fakeSessionService();
		service.resolve = async () => null;
		const error = mock(() => undefined);
		const original = console.error;
		console.error = error;
		try {
			const { app } = createApiApp({ sessionService: service, nodeEnv: "test" });
			const response = await app.request("/api/projects", {
				headers: { cookie: "ac_session=super-secret-session-token" },
			});
			expect(response.status).toBe(401);
			expect(JSON.stringify(error.mock.calls)).not.toContain("super-secret-session-token");
			expect(JSON.stringify(error.mock.calls)).not.toContain("ac_session");
		} finally {
			console.error = original;
		}
	});
});
