/**
 * Map gh PR view + check rollup into domain PullRequestStatus.
 */

import type { GhPrView } from "./gh-json-schemas";
import { isRecord } from "./gh-json-schemas";
import type {
	CheckConclusion,
	CheckObservation,
	PullRequestLifecycleState,
	PullRequestStatus,
	RepositoryRef,
	ReviewDecision,
} from "./github-gateway";

export function normalizeLifecycleState(state: string): PullRequestLifecycleState {
	const s = state.toUpperCase();
	if (s === "MERGED") return "merged";
	if (s === "CLOSED") return "closed";
	if (s === "OPEN") return "open";
	// gh sometimes returns lowercase
	if (state === "merged") return "merged";
	if (state === "closed") return "closed";
	if (state === "open") return "open";
	throw new Error(`unknown PR state: ${state}`);
}

export function normalizeReviewDecision(raw: string | null | undefined): ReviewDecision {
	if (raw == null || raw === "") return "NONE";
	const u = raw.toUpperCase();
	if (u === "APPROVED") return "APPROVED";
	if (u === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
	if (u === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";
	if (u === "NONE") return "NONE";
	return "UNKNOWN";
}

function mapConclusion(
	status: string | null | undefined,
	conclusion: string | null | undefined,
): CheckConclusion {
	const st = (status ?? "").toUpperCase();
	if (st === "QUEUED" || st === "IN_PROGRESS" || st === "PENDING" || st === "REQUESTED") {
		return "pending";
	}
	const c = (conclusion ?? "").toUpperCase();
	if (c === "SUCCESS") return "success";
	if (c === "FAILURE" || c === "STARTUP_FAILURE") return "failure";
	if (c === "NEUTRAL") return "neutral";
	if (c === "CANCELLED" || c === "CANCELED") return "cancelled";
	if (c === "SKIPPED") return "skipped";
	if (c === "TIMED_OUT") return "timed_out";
	if (c === "ACTION_REQUIRED") return "action_required";
	if (!c && st === "COMPLETED") return "unknown";
	if (!c) return "pending";
	return "unknown";
}

function conclusionToBucket(conclusion: CheckConclusion): CheckObservation["bucket"] {
	if (conclusion === "pending") return "pending";
	if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
		return "pass";
	}
	if (conclusion === "cancelled") return "cancel";
	if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required") {
		return "fail";
	}
	return "pending";
}

export function normalizeChecks(rollup: unknown[], headSha: string): CheckObservation[] {
	const out: CheckObservation[] = [];
	for (const item of rollup) {
		if (!isRecord(item)) continue;
		const name =
			typeof item.name === "string"
				? item.name
				: typeof item.context === "string"
					? item.context
					: "check";
		const status = typeof item.status === "string" ? item.status : null;
		const conclusion = typeof item.conclusion === "string" ? item.conclusion : null;
		const mapped = mapConclusion(status, conclusion);
		const detailsUrl =
			typeof item.detailsUrl === "string"
				? item.detailsUrl
				: typeof item.targetUrl === "string"
					? item.targetUrl
					: undefined;
		out.push({
			name,
			conclusion: mapped,
			bucket: conclusionToBucket(mapped),
			headSha,
			detailsUrl,
		});
	}
	return out;
}

export function summarizeChecks(checks: CheckObservation[]): PullRequestStatus["checkSummary"] {
	if (checks.length === 0) return "none";
	if (checks.some((c) => c.conclusion === "pending" || c.bucket === "pending")) {
		return "pending";
	}
	if (
		checks.some(
			(c) =>
				c.conclusion === "failure" ||
				c.conclusion === "timed_out" ||
				c.conclusion === "action_required" ||
				c.bucket === "fail",
		)
	) {
		return "failing";
	}
	return "passing";
}

export function normalizePullRequestStatus(
	view: GhPrView,
	repository: RepositoryRef,
): PullRequestStatus {
	const state = normalizeLifecycleState(view.state);
	const currentHeadSha = view.headRefOid.toLowerCase();
	const checks = normalizeChecks(view.statusCheckRollup, currentHeadSha);
	const mergeable =
		view.mergeable == null
			? null
			: view.mergeable.toUpperCase() === "MERGEABLE"
				? true
				: view.mergeable.toUpperCase() === "CONFLICTING"
					? false
					: null;

	return {
		repository,
		number: view.number,
		url: view.url,
		state,
		currentHeadSha,
		headBranch: view.headRefName,
		baseBranch: view.baseRefName,
		checks,
		checkSummary: summarizeChecks(checks),
		reviewDecision: normalizeReviewDecision(view.reviewDecision),
		mergeCommitSha: view.mergeCommit?.oid.toLowerCase() ?? null,
		mergedAt: view.mergedAt,
		closedAt: view.closedAt,
		updatedAt: view.updatedAt,
		mergeable,
	};
}
