/**
 * Pure failure mapping (F-10). Safe summaries + recommended next actions.
 * Domain stays free of shared package imports — local redaction only.
 */

export const FAILURE_KINDS = [
	"validation",
	"queue",
	"process",
	"task_result",
	"git",
	"github",
	"ci",
	"cancellation",
	"interruption",
	"stale_sync",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export type FailureAttentionCategory =
	| "task_review"
	| "development_failed"
	| "development_interrupted"
	| "pr_creation_failed"
	| "ci_failed"
	| "pr_review"
	| "pr_changes_requested"
	| "blocked"
	| "stale_github_sync"
	| null;

export type FailureRecommendedAction =
	| "fix_input"
	| "retry_development"
	| "retry_pr_creation"
	| "open_github_checks"
	| "open_github_pr"
	| "resolve_block"
	| "refresh_github_status";

export interface MapFailureInput {
	kind: FailureKind;
	/** Optional adapter/diagnostic text — redacted before storage in result. */
	detail?: string;
}

export interface FailureProjection {
	kind: FailureKind;
	summary: string;
	detail?: string;
	recommendedAction: FailureRecommendedAction;
	attentionCategory: FailureAttentionCategory;
	requiresExplicitRetry: boolean;
}

const REDACTED = "[REDACTED]";

const GITHUB_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const AUTH_HEADER_RE = /^(Authorization)\s*:\s*.+$/gim;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/]+=*/gi;
const CREDENTIAL_URL_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g;
const KV_ASSIGN_RE =
	/\b(password|passwd|secret|token|access_token|accessToken|authorization|cookie|session|api_key|apiKey|GITHUB_TOKEN|github_token)\s*([=:])\s*(["']?)([^\s"',;]+)(["']?)/gi;

/** Local redaction so domain never imports shared adapters. */
function redact(text: string): string {
	let out = text;
	out = out.replace(AUTH_HEADER_RE, `$1: ${REDACTED}`);
	out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
	out = out.replace(BASIC_RE, `Basic ${REDACTED}`);
	out = out.replace(GITHUB_TOKEN_RE, REDACTED);
	out = out.replace(CREDENTIAL_URL_RE, `$1${REDACTED}@`);
	out = out.replace(
		KV_ASSIGN_RE,
		(_m, key, sep, q1, _val, q2) => `${key}${sep}${q1}${REDACTED}${q2}`,
	);
	return out;
}

interface FailureSpec {
	summary: string;
	recommendedAction: FailureRecommendedAction;
	attentionCategory: FailureAttentionCategory;
	requiresExplicitRetry: boolean;
}

const SPECS: Record<FailureKind, FailureSpec> = {
	validation: {
		summary: "A validation check failed and progress is blocked.",
		recommendedAction: "fix_input",
		attentionCategory: "blocked",
		requiresExplicitRetry: false,
	},
	queue: {
		summary: "Queue claim or capacity handling failed for this job.",
		recommendedAction: "retry_development",
		attentionCategory: "development_failed",
		requiresExplicitRetry: true,
	},
	process: {
		summary: "The Autopilot process failed or exited unexpectedly.",
		recommendedAction: "retry_development",
		attentionCategory: "development_failed",
		requiresExplicitRetry: true,
	},
	task_result: {
		summary: "Task result verification failed (stuck, invalid, or unpassed requirements).",
		recommendedAction: "retry_development",
		attentionCategory: "development_failed",
		requiresExplicitRetry: true,
	},
	git: {
		summary: "A Git safety or preflight check failed.",
		recommendedAction: "resolve_block",
		attentionCategory: "blocked",
		requiresExplicitRetry: true,
	},
	github: {
		summary: "A GitHub adapter operation failed (auth, push, or PR create).",
		recommendedAction: "retry_pr_creation",
		attentionCategory: "pr_creation_failed",
		requiresExplicitRetry: true,
	},
	ci: {
		summary: "One or more current-head CI checks failed on the feature PR.",
		recommendedAction: "open_github_checks",
		attentionCategory: "ci_failed",
		requiresExplicitRetry: false,
	},
	cancellation: {
		summary: "The owner cancelled the development attempt.",
		recommendedAction: "retry_development",
		attentionCategory: null,
		requiresExplicitRetry: false,
	},
	interruption: {
		summary: "Worker or process ownership was interrupted; manual retry is required.",
		recommendedAction: "retry_development",
		attentionCategory: "development_interrupted",
		requiresExplicitRetry: true,
	},
	stale_sync: {
		summary:
			"Repeated GitHub polling failures left synchronization stale; last known state is preserved.",
		recommendedAction: "refresh_github_status",
		attentionCategory: "stale_github_sync",
		requiresExplicitRetry: false,
	},
};

/**
 * Map a failure kind (+ optional raw detail) to a safe owner-facing projection.
 * Raw credential-bearing adapter output cannot enter the result.
 */
export function mapFailure(input: MapFailureInput): FailureProjection {
	const spec = SPECS[input.kind];
	const result: FailureProjection = {
		kind: input.kind,
		summary: spec.summary,
		recommendedAction: spec.recommendedAction,
		attentionCategory: spec.attentionCategory,
		requiresExplicitRetry: spec.requiresExplicitRetry,
	};
	if (input.detail !== undefined) {
		result.detail = redact(input.detail);
		// Also ensure summary never receives raw detail concatenation.
	}
	return result;
}
