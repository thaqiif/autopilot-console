/**
 * Secure session cookie construction and parsing.
 * HttpOnly + SameSite=Strict always; Secure in production.
 */

export const SESSION_COOKIE_NAME = "ac_session";

export function sessionCookieName(): string {
	return SESSION_COOKIE_NAME;
}

export interface BuildSessionCookieOptions {
	rawToken: string;
	nodeEnv: "development" | "test" | "production";
	maxAgeSeconds: number;
	path?: string;
}

export function buildSessionCookie(options: BuildSessionCookieOptions): string {
	const path = options.path ?? "/";
	const parts = [
		`${SESSION_COOKIE_NAME}=${options.rawToken}`,
		`Path=${path}`,
		`Max-Age=${options.maxAgeSeconds}`,
		"HttpOnly",
		"SameSite=Strict",
	];
	if (options.nodeEnv === "production") {
		parts.push("Secure");
	}
	return parts.join("; ");
}

export function clearSessionCookie(options: {
	nodeEnv: "development" | "test" | "production";
	path?: string;
}): string {
	const path = options.path ?? "/";
	const parts = [
		`${SESSION_COOKIE_NAME}=`,
		`Path=${path}`,
		"Max-Age=0",
		"HttpOnly",
		"SameSite=Strict",
	];
	if (options.nodeEnv === "production") {
		parts.push("Secure");
	}
	return parts.join("; ");
}

/** Extract the named session cookie from a Cookie header. */
export function parseSessionCookie(cookieHeader: string | undefined | null): string | null {
	if (!cookieHeader) return null;
	const parts = cookieHeader.split(";");
	for (const part of parts) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const name = trimmed.slice(0, eq).trim();
		if (name === SESSION_COOKIE_NAME) {
			const value = trimmed.slice(eq + 1).trim();
			return value.length > 0 ? value : null;
		}
	}
	return null;
}
