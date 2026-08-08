/**
 * Opaque revocable session lifecycle against PostgreSQL.
 * Raw tokens leave the process only at login; DB stores SHA-256 hash.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type AdminAccountRow,
	createSession,
	getAdminAccountById,
	getAdminAccountByUsername,
	getSessionById,
	getSessionByTokenHash,
	type Queryable,
	revokeSessionById,
	type SessionRow,
} from "../../../../packages/database/src/index";
import type { LoginRateLimiter } from "./login-rate-limit";
import { verifyPassword } from "./password";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const AUTH_FAILURE_MESSAGE = "Invalid credentials";
// Precomputed argon2id of a constant so missing-user logins still pay verify cost.
const DUMMY_PASSWORD_HASH =
	"$argon2id$v=19$m=65536,t=2,p=1$9F0tBy9LR6vm64N7D8gWNvd35+ZIpCQsSevxuZVYigk$qrOy35OvqDBMFASlOTS7EicSjEveGxCalc+40MIA9ZI";

export type LoginFailureCode = "UNAUTHORIZED" | "RATE_LIMITED";

export type LoginResult =
	| {
			ok: true;
			rawToken: string;
			session: SessionRow;
			admin: AdminAccountRow;
	  }
	| {
			ok: false;
			code: LoginFailureCode;
			message: string;
	  };

export interface ResolvedSession {
	session: SessionRow;
	admin: AdminAccountRow;
}

export interface SessionServiceOptions {
	sql: Queryable;
	now?: () => Date;
	ttlMs?: number;
	rateLimiter?: LoginRateLimiter;
}

export interface SessionService {
	login(input: { username: string; password: string; clientKey?: string }): Promise<LoginResult>;
	resolve(input: { rawToken: string }): Promise<ResolvedSession | null>;
	logout(input: { rawToken: string }): Promise<void>;
	revoke(input: { sessionId: string }): Promise<void>;
}

function hashToken(rawToken: string): string {
	return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function mintRawToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Constant-time-ish compare for equal-length hex digests. */
function safeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
	} catch {
		return false;
	}
}

export function createSessionService(options: SessionServiceOptions): SessionService {
	const sql = options.sql;
	const now = options.now ?? (() => new Date());
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const rateLimiter = options.rateLimiter;

	return {
		async login(input) {
			const clientKey = input.clientKey ?? "default";
			if (rateLimiter?.isLimited(clientKey)) {
				return {
					ok: false,
					code: "RATE_LIMITED",
					message: "Too many login attempts. Wait and retry.",
				};
			}

			const admin = await getAdminAccountByUsername(sql, input.username.trim());
			// Always verify (dummy hash when admin missing) to reduce timing leaks.
			const passwordOk = await verifyPassword(
				input.password,
				admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
			);

			if (!admin || !passwordOk) {
				rateLimiter?.recordFailure(clientKey);
				return {
					ok: false,
					code: "UNAUTHORIZED",
					message: AUTH_FAILURE_MESSAGE,
				};
			}

			rateLimiter?.recordSuccess(clientKey);

			const rawToken = mintRawToken();
			const tokenHash = hashToken(rawToken);
			const expiresAt = new Date(now().getTime() + ttlMs);
			const session = await createSession(sql, {
				adminAccountId: admin.id,
				tokenHash,
				expiresAt,
			});

			return { ok: true, rawToken, session, admin };
		},

		async resolve(input) {
			const tokenHash = hashToken(input.rawToken);
			const session = await getSessionByTokenHash(sql, tokenHash);
			if (!session) return null;
			if (session.revokedAt !== null) return null;
			if (session.expiresAt.getTime() <= now().getTime()) return null;
			// Defense: re-check hash equality
			if (!safeEqualHex(session.tokenHash, tokenHash)) return null;

			const admin = await getAdminAccountById(sql, session.adminAccountId);
			if (!admin) return null;
			return { session, admin };
		},

		async logout(input) {
			const tokenHash = hashToken(input.rawToken);
			const session = await getSessionByTokenHash(sql, tokenHash);
			if (!session) return;
			await revokeSessionById(sql, { id: session.id, revokedAt: now() });
		},

		async revoke(input) {
			const existing = await getSessionById(sql, input.sessionId);
			if (!existing) return;
			await revokeSessionById(sql, { id: input.sessionId, revokedAt: now() });
		},
	};
}
