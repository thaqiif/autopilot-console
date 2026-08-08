/**
 * Double-submit CSRF token helpers for browser mutations.
 * Login and health routes are exempt.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_COOKIE_NAME = "ac_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const EXEMPT_PREFIXES = ["/api/auth/login", "/api/health"];

export function csrfCookieName(): string {
	return CSRF_COOKIE_NAME;
}

export function csrfHeaderName(): string {
	return CSRF_HEADER_NAME;
}

export function createCsrfToken(): string {
	return randomBytes(32).toString("base64url");
}

export function validateCsrf(input: {
	cookieToken: string | undefined | null;
	headerToken: string | undefined | null;
}): boolean {
	const cookie = input.cookieToken ?? "";
	const header = input.headerToken ?? "";
	if (cookie.length === 0 || header.length === 0) return false;
	if (cookie.length !== header.length) return false;
	try {
		return timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
	} catch {
		return false;
	}
}

/** Paths that may mutate without CSRF (login) or are read-only health. */
export function isCsrfExemptPath(path: string): boolean {
	const normalized = path.split("?")[0] ?? path;
	return EXEMPT_PREFIXES.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
	);
}
