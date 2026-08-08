/**
 * CSRF (double-submit token) middleware for browser mutations.
 * Login and health are exempt; every other state-changing request must carry
 * a valid CSRF token. Validation uses the session-bound CsrfProtector so the
 * HttpOnly cookie need not be readable by the SPA.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { createNormalizedError } from "../../../../packages/shared/src/index";
import { isCsrfExemptPath } from "../auth/csrf";
import type { CsrfProtector } from "../security/csrf-protector";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface CsrfMiddlewareOptions {
	csrf: CsrfProtector;
	trustedOrigins?: readonly string[];
}

function requestOrigin(c: Context): string {
	return new URL(c.req.url).origin;
}

function hasValidOrigin(c: Context, trustedOrigins: readonly string[]): boolean {
	const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
	if (fetchSite === "cross-site") return false;
	const origin = c.req.header("Origin");
	if (!origin) return true;
	return trustedOrigins.includes(origin);
}

export function csrfMiddleware(options: CsrfMiddlewareOptions): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const method = c.req.method.toUpperCase();
		if (!MUTATING_METHODS.has(method)) {
			await next();
			return;
		}
		const correlationId = c.get("correlationId") ?? "";
		const trustedOrigins = options.trustedOrigins ?? [requestOrigin(c)];
		if (!hasValidOrigin(c, trustedOrigins)) {
			throw createNormalizedError({
				code: "FORBIDDEN",
				message: "Cross-origin mutation is not allowed.",
				httpStatus: 403,
				correlationId,
			});
		}
		if (isCsrfExemptPath(c.req.path)) {
			await next();
			return;
		}
		const ok = options.csrf.validate({
			sessionCookie: c.req.header("Cookie"),
			csrfCookie: c.req.header("ac-csrf"),
			csrfHeader: c.req.header("x-csrf-token"),
		});
		if (!ok) {
			throw createNormalizedError({
				code: "FORBIDDEN",
				message: "Missing or mismatched CSRF token.",
				httpStatus: 403,
				correlationId,
			});
		}
		await next();
	};
}
