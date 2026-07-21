/**
 * Authentication middleware — default-deny boundary for the API.
 * Resolves the opaque session cookie against the SessionService; rejects
 * missing, expired, revoked, or invalid sessions with a typed 401 envelope.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { createNormalizedError } from "../../../../packages/shared/src/index";
import { parseSessionCookie } from "../auth/session-cookie";
import type { SessionService } from "../auth/session-service";

export interface AuthVars {
	correlationId: string;
	adminId: string;
	adminUsername: string;
}

const PUBLIC_ROUTES = new Set(["GET /api/health", "GET /api/health/live", "POST /api/auth/login"]);

function isPublicRequest(method: string, path: string): boolean {
	const normalized = path.split("?")[0] ?? path;
	return PUBLIC_ROUTES.has(`${method.toUpperCase()} ${normalized}`);
}

export interface AuthenticationOptions {
	sessionService: SessionService;
}

export function authenticationMiddleware(options: AuthenticationOptions): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		if (isPublicRequest(c.req.method, c.req.path)) {
			await next();
			return;
		}
		const correlationId = c.get("correlationId") ?? "";
		const cookieHeader = c.req.header("Cookie");
		const rawToken = parseSessionCookie(cookieHeader);
		if (!rawToken) {
			throw createNormalizedError({
				code: "UNAUTHORIZED",
				message: "Authentication required.",
				httpStatus: 401,
				correlationId,
			});
		}
		const resolved = await options.sessionService.resolve({ rawToken });
		if (!resolved) {
			throw createNormalizedError({
				code: "UNAUTHORIZED",
				message: "Session is invalid, expired, or revoked.",
				httpStatus: 401,
				correlationId,
			});
		}
		c.set("adminId", resolved.admin.id);
		c.set("adminUsername", resolved.admin.username);
		await next();
	};
}
