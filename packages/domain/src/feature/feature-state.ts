/**
 * Closed Phase 1 feature lifecycle states (F-5).
 * Single source of truth for domain; database enum mirrors this set.
 */
export const FEATURE_STATES = [
	"PLANNED",
	"TASKS_REVIEW",
	"QUEUED",
	"DEVELOPING",
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
	"DEVELOPMENT_COMPLETE",
	"PR_CREATING",
	"PR_CREATION_FAILED",
	"CI_RUNNING",
	"CI_FAILED",
	"PR_REVIEW",
	"PR_CHANGES_REQUESTED",
	"DEVELOPMENT_MERGED",
	"BLOCKED",
] as const;

export type FeatureState = (typeof FEATURE_STATES)[number];

export const TERMINAL_FEATURE_STATES = [
	"DEVELOPMENT_MERGED",
] as const satisfies readonly FeatureState[];

export type TerminalFeatureState = (typeof TERMINAL_FEATURE_STATES)[number];

export function isFeatureState(value: string): value is FeatureState {
	return (FEATURE_STATES as readonly string[]).includes(value);
}

export function isTerminalFeatureState(state: FeatureState): boolean {
	return (TERMINAL_FEATURE_STATES as readonly FeatureState[]).includes(state);
}
