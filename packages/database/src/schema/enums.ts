export const projectStatuses = ["active", "archived"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const releaseStatuses = ["PLANNED", "IN_DEVELOPMENT", "DEVELOPMENT_MERGED"] as const;
export type ReleaseStatus = (typeof releaseStatuses)[number];

export const featureStates = [
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
export type FeatureState = (typeof featureStates)[number];

export const pullRequestObservedStates = ["open", "closed", "merged"] as const;
export type PullRequestObservedState = (typeof pullRequestObservedStates)[number];
