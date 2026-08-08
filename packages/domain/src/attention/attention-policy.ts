import type { FeatureState } from "../feature/feature-state";

export const ATTENTION_CATEGORIES = [
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

export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number];

export const ATTENTION_ACTIONS = [
	"review_tasks",
	"retry_development",
	"retry_pr_creation",
	"open_github_checks",
	"open_github_pr",
	"resolve_block",
	"refresh_github_status",
] as const;

export type AttentionAction = (typeof ATTENTION_ACTIONS)[number];

export interface AttentionInput {
	projectId: string;
	releaseId?: string;
	featureId: string;
	state: FeatureState;
	/** ISO-8601 UTC basis for age (usually last state change). */
	stateChangedAt: string;
	/** When true, GitHub polling has repeatedly failed while preserving last state. */
	staleGithubSync?: boolean;
	/** ISO-8601 UTC when stale sync was first observed. */
	staleSince?: string;
}

export interface AttentionItem {
	projectId: string;
	releaseId?: string;
	featureId: string;
	reason: AttentionCategory;
	ageBasis: string;
	currentState: FeatureState;
	category: AttentionCategory;
	primaryAction: AttentionAction;
}

interface LifecycleAttention {
	category: AttentionCategory;
	primaryAction: AttentionAction;
}

/** Lifecycle states that always produce attention (F-5 / F-12). */
const LIFECYCLE_ATTENTION: Partial<Record<FeatureState, LifecycleAttention>> = {
	TASKS_REVIEW: { category: "task_review", primaryAction: "review_tasks" },
	DEVELOPMENT_FAILED: {
		category: "development_failed",
		primaryAction: "retry_development",
	},
	DEVELOPMENT_INTERRUPTED: {
		category: "development_interrupted",
		primaryAction: "retry_development",
	},
	PR_CREATION_FAILED: {
		category: "pr_creation_failed",
		primaryAction: "retry_pr_creation",
	},
	CI_FAILED: { category: "ci_failed", primaryAction: "open_github_checks" },
	PR_REVIEW: { category: "pr_review", primaryAction: "open_github_pr" },
	PR_CHANGES_REQUESTED: {
		category: "pr_changes_requested",
		primaryAction: "open_github_pr",
	},
	BLOCKED: { category: "blocked", primaryAction: "resolve_block" },
};

/**
 * Derive a single attention item from persisted feature workflow state.
 * Lifecycle attention wins over stale GitHub sync when both apply.
 * Healthy waiting/planned/queued/running/cancelled/complete/merged → null
 * unless only stale sync is set.
 */
export function deriveAttention(input: AttentionInput): AttentionItem | null {
	const lifecycle = LIFECYCLE_ATTENTION[input.state];
	if (lifecycle) {
		return {
			projectId: input.projectId,
			...(input.releaseId !== undefined ? { releaseId: input.releaseId } : {}),
			featureId: input.featureId,
			reason: lifecycle.category,
			ageBasis: input.stateChangedAt,
			currentState: input.state,
			category: lifecycle.category,
			primaryAction: lifecycle.primaryAction,
		};
	}

	if (input.staleGithubSync) {
		return {
			projectId: input.projectId,
			...(input.releaseId !== undefined ? { releaseId: input.releaseId } : {}),
			featureId: input.featureId,
			reason: "stale_github_sync",
			ageBasis: input.staleSince ?? input.stateChangedAt,
			currentState: input.state,
			category: "stale_github_sync",
			primaryAction: "refresh_github_status",
		};
	}

	return null;
}

/** Filter a collection to only attention-producing features, preserving order. */
export function deriveAttentionForFeatures(inputs: readonly AttentionInput[]): AttentionItem[] {
	const out: AttentionItem[] = [];
	for (const input of inputs) {
		const item = deriveAttention(input);
		if (item) out.push(item);
	}
	return out;
}
