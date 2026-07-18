const REDACTED = "[REDACTED]";

/** Sensitive key names (case-insensitive) whose values are fully redacted. */
const SENSITIVE_KEYS = new Set([
	"password",
	"passwd",
	"secret",
	"token",
	"access_token",
	"accesstoken",
	"refresh_token",
	"refreshtoken",
	"client_secret",
	"clientsecret",
	"authorization",
	"cookie",
	"set-cookie",
	"set_cookie",
	"session",
	"session_token",
	"sessiontoken",
	"api_key",
	"apikey",
	"github_token",
	"githubtoken",
	"private_key",
	"privatekey",
]);

const GITHUB_TOKEN_RE =
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

// Authorization / Cookie header lines and JSON-ish key:value pairs with credentials.
const AUTH_HEADER_RE = /^(Authorization)\s*:\s*.+$/gim;
const COOKIE_HEADER_RE = /^(Cookie|Set-Cookie)\s*:\s*.+$/gim;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/]+=*/gi;

// key=value and "key":"value" / key: "value" for known secret keys
const KV_ASSIGN_RE =
	/\b(password|passwd|secret|token|access_token|accessToken|refresh_token|refreshToken|client_secret|clientSecret|authorization|cookie|session|api_key|apiKey|GITHUB_TOKEN|github_token)\s*([=:])\s*(["']?)([^\s"',;]+)(["']?)/gi;

const JSON_KEY_RE =
	/("?(?:password|passwd|secret|token|access_token|accessToken|refresh_token|refreshToken|client_secret|clientSecret|authorization|cookie|session|api_key|apiKey|GITHUB_TOKEN|github_token)"?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi;

// URLs with embedded credentials: scheme://user:pass@host
const CREDENTIAL_URL_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g;

function isSensitiveKey(key: string): boolean {
	const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	if (SENSITIVE_KEYS.has(normalized)) return true;
	// Common compound forms: foo_password, myToken, etc.
	return (
		normalized.endsWith("password") ||
		normalized.endsWith("passwd") ||
		normalized.endsWith("secret") ||
		normalized.endsWith("token") ||
		normalized.endsWith("apikey") ||
		normalized === "authorization" ||
		normalized === "cookie" ||
		normalized === "setcookie"
	);
}

/**
 * Redact common secret patterns from free-form diagnostic text.
 * Intentionally does not rewrite prose that only mentions the words
 * "password", "authorization", "token", or "cookie" without an assignment.
 */
export function redactSecrets(input: string): string {
	let out = input;

	out = out.replace(AUTH_HEADER_RE, "$1: [REDACTED]");
	out = out.replace(COOKIE_HEADER_RE, "$1: [REDACTED]");
	out = out.replace(BEARER_RE, "Bearer [REDACTED]");
	out = out.replace(BASIC_RE, "Basic [REDACTED]");
	out = out.replace(GITHUB_TOKEN_RE, REDACTED);
	out = out.replace(CREDENTIAL_URL_RE, `$1${REDACTED}@`);
	out = out.replace(JSON_KEY_RE, `$1"${REDACTED}"`);
	out = out.replace(KV_ASSIGN_RE, (_match, key, sep, q1, _val, q2) => {
		// Preserve surrounding quotes when present
		const quote = q1 || q2 || "";
		return `${key}${sep}${quote}${REDACTED}${quote}`;
	});

	return out;
}

/**
 * Deep-redact values whose keys look sensitive and scrub string leaves.
 * Returns a new structure; never mutates the input.
 */
export function redactValue(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return redactSecrets(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => redactValue(item));
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (isSensitiveKey(key)) {
				result[key] = REDACTED;
			} else if (typeof child === "string") {
				result[key] = redactSecrets(child);
			} else {
				result[key] = redactValue(child);
			}
		}
		return result;
	}
	return value;
}
