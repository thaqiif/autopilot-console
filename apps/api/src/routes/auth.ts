/**
 * Authentication routes: login and logout.
 * Login is CSRF-exempt (it establishes the session); logout requires CSRF.
 * Raw session tokens never appear in response bodies or logs.
 */

import { Hono } from "hono";
import { createNormalizedError, type NodeEnv } from "../../../../packages/shared/src/index";
import { buildSessionCookie, clearSessionCookie, parseSessionCookie } from "../auth/session-cookie";
import type { LoginResult, SessionService } from "../auth/session-service";
import type { CsrfProtector } from "../security/csrf-protector";
import { SESSION_MAX_AGE_SECONDS } from "./session-config";

export interface AuthRoutesOptions {
	sessionService: SessionService;
	csrf: CsrfProtector;
	nodeEnv: NodeEnv;
}

function loginResultToResponse(result: LoginResult, nodeEnv: NodeEnv, correlationId: string) {
	if (!result.ok) {
		const code = result.code === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAUTHORIZED";
		throw createNormalizedError({
			code,
			message: result.message,
			httpStatus: code === "RATE_LIMITED" ? 429 : 401,
			correlationId,
		});
	}
	const cookie = buildSessionCookie({
		rawToken: result.rawToken,
		nodeEnv,
		maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
	});
	return { rawToken: result.rawToken, setCookie: cookie };
}

export function createAuthRoutes(options: AuthRoutesOptions): Hono {
	const app = new Hono();
	const { sessionService, nodeEnv, csrf } = options;

	app.post("/api/auth/login", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		let body: { username?: string; password?: string };
		try {
			body = await c.req.json();
		} catch {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Request body must be JSON.",
				httpStatus: 400,
				correlationId,
			});
		}
		if (!body.username || !body.password) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "username and password are required.",
				httpStatus: 400,
				correlationId,
			});
		}
		const result = await sessionService.login({
			username: body.username,
			password: body.password,
		});
		const { rawToken, setCookie } = loginResultToResponse(result, nodeEnv, correlationId);
		const csrfToken = csrf.issue(rawToken);
		c.header("Set-Cookie", setCookie, { append: true });
		return c.json({ ok: true as const, data: { authenticated: true, csrfToken } }, 200);
	});

	app.get("/api/auth/session", (c) => {
		const rawToken = parseSessionCookie(c.req.header("Cookie"));
		if (!rawToken) {
			throw createNormalizedError({
				code: "UNAUTHORIZED",
				message: "Authentication required.",
				httpStatus: 401,
				correlationId: c.get("correlationId") ?? "",
			});
		}
		return c.json({
			ok: true as const,
			data: {
				authenticated: true,
				username: c.get("adminUsername"),
				csrfToken: csrf.issue(rawToken),
			},
		});
	});

	app.post("/api/auth/logout", async (c) => {
		const rawToken = parseSessionCookie(c.req.header("Cookie"));
		if (rawToken) {
			await sessionService.logout({ rawToken });
			csrf.revoke(rawToken);
		}
		const clear = clearSessionCookie({ nodeEnv });
		c.header("Set-Cookie", clear, { append: true });
		return c.json({ ok: true as const, data: { loggedOut: true } }, 200);
	});

	return app;
}
