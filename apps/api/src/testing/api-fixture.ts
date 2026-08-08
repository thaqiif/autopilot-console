/**
 * Test harness for requirement 21 — wires the real Hono API app boundary.
 *
 * Uses isolated PostgreSQL and a fake clock. Bootstraps the sole administrator,
 * exposes login/logout/issueCsrf, and reports the protected route matrix so the
 * route-protection tests can verify default-deny behavior. No real
 * Autopilot/Git/GitHub effects are involved.
 */

import type { Hono } from "hono";
import type { Sql } from "../../../../packages/database/src/index";
import { type ApiApp, createApiApp } from "../app";
import { bootstrapAdministrator } from "../auth/admin-bootstrap";
import { buildSessionCookie, SESSION_COOKIE_NAME } from "../auth/session-cookie";
import type { SessionService } from "../auth/session-service";
import { SESSION_MAX_AGE_SECONDS } from "../routes/session-config";
import { type CsrfProtector, createCsrfProtector } from "../security/csrf-protector";

export interface Clock {
	now: () => Date;
	advanceMs: (ms: number) => void;
}

export interface LoginOutcome {
	ok: true;
	token: string;
	setCookie: string;
}

export interface ApiTestHarness {
	login(input: {
		username: string;
		password: string;
	}): Promise<LoginOutcome | { ok: false; status: number }>;
	/**
	 * Login via the session service directly, bypassing Hono app.request()
	 * cookie extraction. Returns the raw token reliably regardless of
	 * environment-specific Set-Cookie header handling.
	 */
	directLogin(input: {
		username: string;
		password: string;
	}): Promise<LoginOutcome | { ok: false; status: number }>;
	issueCsrf(token: string): Promise<string>;
	logout(token: string): Promise<{ status: number; setCookie: string }>;
	bootstrapAdmin(input: { username: string; password: string }): Promise<void>;
	protectedRouteMatrix(): Array<{ method: string; path: string }>;
	app: Hono;
}

export interface ApiTestHarnessOptions {
	sql: Sql;
	sessionService: SessionService;
	now: () => Date;
	adapters?: import("../app").DomainAdapters;
}

const ADMIN_PASSWORD = "Bootstrap-Passw0rd!";
const NODE_ENV: "development" | "test" | "production" = "test";

function firstSetCookie(headers: Headers): string {
	const cookies = headers.getSetCookie?.() ?? [];
	return cookies[0] ?? headers.get("set-cookie") ?? "";
}

export async function createApiTestHarness(
	options: ApiTestHarnessOptions,
): Promise<ApiTestHarness> {
	const csrf: CsrfProtector = createCsrfProtector();
	const built: ApiApp = createApiApp({
		sessionService: options.sessionService,
		nodeEnv: NODE_ENV,
		now: options.now,
		csrf,
		adapters: options.adapters,
	});
	const app = built.app;

	async function bootstrapAdmin(input: { username: string; password: string }): Promise<void> {
		await bootstrapAdministrator(options.sql, {
			username: input.username,
			bootstrapPassword: input.password ?? ADMIN_PASSWORD,
			now: options.now,
		});
	}

	async function login(input: {
		username: string;
		password: string;
	}): Promise<LoginOutcome | { ok: false; status: number }> {
		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: input.username, password: input.password }),
		});
		if (res.status !== 200) {
			return { ok: false, status: res.status };
		}
		const setCookie = firstSetCookie(res.headers);
		const token = extractCookieValue(setCookie, SESSION_COOKIE_NAME) ?? "";
		return { ok: true, token, setCookie };
	}

	return {
		app,
		bootstrapAdmin,
		login,
		async directLogin(input: {
			username: string;
			password: string;
		}): Promise<LoginOutcome | { ok: false; status: number }> {
			const result = await options.sessionService.login({
				username: input.username,
				password: input.password,
			});
			if (!result.ok) {
				return { ok: false, status: result.code === "RATE_LIMITED" ? 429 : 401 };
			}
			const setCookie = buildSessionCookie({
				rawToken: result.rawToken,
				nodeEnv: NODE_ENV,
				maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
			});
			return { ok: true, token: result.rawToken, setCookie };
		},
		async issueCsrf(token: string): Promise<string> {
			return csrf.issue(token);
		},
		async logout(token: string): Promise<{ status: number; setCookie: string }> {
			const csrfToken = csrf.issue(token);
			const res = await app.request("/api/auth/logout", {
				method: "POST",
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, "x-csrf-token": csrfToken },
			});
			return { status: res.status, setCookie: firstSetCookie(res.headers) };
		},
		protectedRouteMatrix(): Array<{ method: string; path: string }> {
			const PUBLIC_PREFIXES = ["/api/health", "/api/auth/login"];
			const isPublic = (p: string) => {
				const normalized = p.split("?")[0] ?? p;
				return PUBLIC_PREFIXES.some(
					(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
				);
			};
			// Hono exposes registered routes via app.routes; each entry has path + method.
			// Filter out wildcard middleware entries (method='ALL' or path='/*') that are
			// not real endpoints but framework-level hooks.
			const honoRoutes = app.routes as Array<{ method: string; path: string }> | undefined;
			const all: Array<{ method: string; path: string }> =
				honoRoutes
					?.filter((r) => r.method !== "ALL" && r.path !== "/*")
					.map((r) => ({ method: r.method, path: r.path })) ?? [];
			return all.filter((r) => !isPublic(r.path));
		},
	};
}

function extractCookieValue(setCookie: string, name: string): string | null {
	if (!setCookie) return null;
	const prefix = `${name}=`;
	if (!setCookie.startsWith(prefix)) return null;
	const end = setCookie.indexOf(";");
	const raw = end === -1 ? setCookie.slice(prefix.length) : setCookie.slice(prefix.length, end);
	return raw.length > 0 ? raw : null;
}
