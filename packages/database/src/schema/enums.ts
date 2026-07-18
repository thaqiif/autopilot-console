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

export const jobAttemptStatuses = [
	"QUEUED",
	"RUNNING",
	"CANCEL_REQUESTED",
	"SUCCEEDED",
	"FAILED",
	"INTERRUPTED",
	"CANCELLED",
] as const;
export type JobAttemptStatus = (typeof jobAttemptStatuses)[number];

export const outboxStatuses = ["pending", "claimed", "completed", "failed"] as const;
export type OutboxStatus = (typeof outboxStatuses)[number];

export const scheduleStatuses = ["pending", "claimed", "completed", "failed", "cancelled"] as const;
export type ScheduleStatus = (typeof scheduleStatuses)[number];

export const diagnosticStreams = ["stdout", "stderr"] as const;
export type DiagnosticStream = (typeof diagnosticStreams)[number];

export const auditActorTypes = [
	"administrator",
	"api_system",
	"worker",
	"autopilot_process",
	"github_poller",
	"reconciliation",
] as const;
export type AuditActorType = (typeof auditActorTypes)[number];
