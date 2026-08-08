/**
 * Session-bound CSRF protection for the API boundary (requirement 21).
 *
 * Tokens are issued server-side and bound to an opaque authenticated session.
 * A matching attacker-controlled cookie/header pair is insufficient because
 * validation always uses the token retained for the session.
 */

import { createCsrfToken, validateCsrf } from "../auth/csrf";
import { parseSessionCookie } from "../auth/session-cookie";

export interface CsrfProtector {
	/** Issue (and remember) a CSRF token bound to the given session token. */
	issue(sessionToken: string): string;
	/** Remove every CSRF token associated with a logged-out session. */
	revoke(sessionToken: string): void;
	/** Validate a header token against the authenticated session. */
	validate(input: {
		sessionCookie: string | undefined | null;
		csrfCookie: string | undefined | null;
		csrfHeader: string | undefined | null;
	}): boolean;
}

export function createCsrfProtector(): CsrfProtector {
	const bySession = new Map<string, string>();
	return {
		issue(sessionToken: string): string {
			const token = createCsrfToken();
			bySession.set(sessionToken, token);
			return token;
		},
		revoke(sessionToken: string): void {
			bySession.delete(sessionToken);
		},
		validate(input) {
			const rawToken = parseSessionCookie(input.sessionCookie);
			if (!rawToken) return false;
			const expected = bySession.get(rawToken);
			return validateCsrf({ cookieToken: expected, headerToken: input.csrfHeader });
		},
	};
}
