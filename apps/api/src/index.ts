/**
 * @autopilot-console/api
 * Package boundary entrypoint. Public API surface grows with later requirements.
 */
export const packageName = "@autopilot-console/api" as const;

export { type ApiApp, type ApiAppOptions, createApiApp } from "./app";
export { bootstrapAdministrator } from "./auth/admin-bootstrap";
export {
	createCsrfToken,
	csrfCookieName,
	csrfHeaderName,
	isCsrfExemptPath,
	validateCsrf,
} from "./auth/csrf";
export { LoginRateLimiter } from "./auth/login-rate-limit";
export { assertStrongPassword, hashPassword, verifyPassword } from "./auth/password";
export {
	buildSessionCookie,
	clearSessionCookie,
	parseSessionCookie,
	SESSION_COOKIE_NAME,
	sessionCookieName,
} from "./auth/session-cookie";
export {
	createSessionService,
	type LoginResult,
	type ResolvedSession,
	type SessionService,
	type SessionServiceOptions,
} from "./auth/session-service";
export {
	createHealthService,
	type HealthReport,
	type HealthService,
} from "./health/health-service";
export { createHealthRoutes } from "./routes/health";
export { type CsrfProtector, createCsrfProtector } from "./security/csrf-protector";
export { createServer, type ServerHandle } from "./server";
