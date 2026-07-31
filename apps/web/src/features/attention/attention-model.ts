/**
 * Shared attention presentation helpers for Overview and Attention pages.
 * Accepts both the domain API shape (ageBasis/currentState/action codes) and
 * the human-readable fixture shape used by unit tests.
 */

export interface AttentionItemInput {
	projectId: string;
	releaseId?: string | null;
	featureId: string;
	reason?: string;
	state?: string;
	currentState?: string;
	age?: string;
	ageBasis?: string;
	category: string;
	primaryAction: string;
	githubUrl?: string | null;
	prUrl?: string | null;
}

export interface AttentionCardModel {
	projectId: string;
	releaseId?: string;
	featureId: string;
	reason: string;
	state: string;
	age: string;
	category: string;
	primaryAction: string;
	primaryActionCode: string;
	href: string;
	external: boolean;
}

export const ATTENTION_CATEGORY_ORDER = [
	"task_review",
	"development_failed",
	"development_interrupted",
	"pr_creation_failed",
	"ci_failed",
	"pr_review",
	"pr_changes_requested",
	"blocked",
	"stale_github_sync",
] as const;

const ACTION_LABELS: Record<string, string> = {
	review_tasks: "Review tasks",
	retry_development: "View failure",
	retry_pr_creation: "View failure",
	open_github_checks: "View failure",
	open_github_pr: "View on GitHub",
	resolve_block: "View details",
	refresh_github_status: "View details",
	"Review tasks": "Review tasks",
	"View failure": "View failure",
	"View on GitHub": "View on GitHub",
	"View details": "View details",
};

const CATEGORY_REASON: Record<string, string> = {
	task_review: "Task review required",
	development_failed: "Development failed",
	development_interrupted: "Development interrupted",
	pr_creation_failed: "PR creation failed",
	ci_failed: "CI failed",
	pr_review: "PR awaiting review",
	pr_changes_requested: "PR changes requested",
	blocked: "Feature blocked",
	stale_github_sync: "GitHub status is stale",
};

const HUMAN_ACTIONS = new Set(["Review tasks", "View failure", "View on GitHub", "View details"]);

export function formatAttentionCategory(category: string): string {
	return category
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function labelForPrimaryAction(action: string): string {
	return ACTION_LABELS[action] ?? formatAttentionCategory(action);
}

export function normalizePrimaryActionCode(action: string, category: string): string {
	if (!HUMAN_ACTIONS.has(action)) return action;
	switch (category) {
		case "task_review":
			return "review_tasks";
		case "development_failed":
		case "development_interrupted":
			return "retry_development";
		case "pr_creation_failed":
			return "retry_pr_creation";
		case "ci_failed":
			return "open_github_checks";
		case "pr_review":
		case "pr_changes_requested":
			return "open_github_pr";
		case "stale_github_sync":
			return "refresh_github_status";
		case "blocked":
			return "resolve_block";
		default:
			return action;
	}
}

function featurePath(projectId: string, featureId: string, hash?: string): string {
	const base = `/projects/${projectId}/features/${featureId}`;
	return hash ? `${base}#${hash}` : base;
}

export function resolveAttentionHref(input: AttentionItemInput): {
	href: string;
	external: boolean;
} {
	const code = normalizePrimaryActionCode(input.primaryAction, input.category);
	const externalUrl = input.githubUrl ?? input.prUrl ?? null;

	if (
		(code === "open_github_pr" || code === "open_github_checks") &&
		typeof externalUrl === "string" &&
		externalUrl.length > 0
	) {
		return { href: externalUrl, external: true };
	}

	switch (code) {
		case "review_tasks":
			return {
				href: featurePath(input.projectId, input.featureId, "tasks"),
				external: false,
			};
		case "retry_development":
		case "retry_pr_creation":
		case "open_github_checks":
			return {
				href: featurePath(input.projectId, input.featureId, "failure"),
				external: false,
			};
		case "open_github_pr":
			return {
				href: featurePath(input.projectId, input.featureId, "pull-request"),
				external: false,
			};
		default:
			return {
				href: featurePath(input.projectId, input.featureId),
				external: false,
			};
	}
}

export function toAttentionCardModel(input: AttentionItemInput): AttentionCardModel {
	const state = input.currentState ?? input.state ?? "";
	const rawReason = input.reason ?? input.category;
	const reason =
		rawReason.includes("_") && CATEGORY_REASON[rawReason] ? CATEGORY_REASON[rawReason] : rawReason;
	const age =
		input.age ??
		(input.ageBasis
			? // Keep ISO basis readable when relative formatting is unavailable to callers.
				input.ageBasis
			: "");
	const primaryAction = labelForPrimaryAction(input.primaryAction);
	const primaryActionCode = normalizePrimaryActionCode(input.primaryAction, input.category);
	const { href, external } = resolveAttentionHref(input);

	return {
		projectId: input.projectId,
		...(input.releaseId ? { releaseId: input.releaseId } : {}),
		featureId: input.featureId,
		reason,
		state,
		age,
		category: input.category,
		primaryAction,
		primaryActionCode,
		href,
		external,
	};
}
