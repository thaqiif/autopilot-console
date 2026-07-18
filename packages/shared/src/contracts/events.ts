import type { FeatureId, JobAttemptId, ProjectId, ReleaseId } from "./ids.ts";

/** High-level activity categories recorded for the portfolio timeline. */
export type ActivityCategory =
	| "project"
	| "release"
	| "feature"
	| "task"
	| "job"
	| "process"
	| "git"
	| "github"
	| "system";

export interface ActivityEventDraft {
	category: ActivityCategory;
	type: string;
	message: string;
	occurredAt: string;
	projectId?: ProjectId;
	releaseId?: ReleaseId;
	featureId?: FeatureId;
	jobAttemptId?: JobAttemptId;
	correlationId?: string;
	/** Safe structured payload — must already be redacted. */
	payload?: Record<string, unknown>;
}

export interface AuditEventDraft {
	actorId: string;
	action: string;
	targetType: string;
	targetId: string;
	occurredAt: string;
	result: "success" | "failure" | "rejected";
	projectId?: ProjectId;
	featureId?: FeatureId;
	jobAttemptId?: JobAttemptId;
	correlationId?: string;
	/** Safe prior/next snapshots — never credentials. */
	prior?: Record<string, unknown>;
	next?: Record<string, unknown>;
}
