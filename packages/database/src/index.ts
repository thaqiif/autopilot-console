/**
 * @autopilot-console/database
 * PostgreSQL client, migrations, schema, and repositories.
 */

export {
	createDatabaseClient,
	type DatabaseClient,
	type Queryable,
	type Sql,
	type TransactionSql,
} from "./client";
export {
	type AdminAccountRow,
	countAdminAccounts,
	createAdminAccount,
	createFeature,
	createProject,
	createPullRequestIdentity,
	createRelease,
	createSession,
	createTaskApproval,
	createWorkspace,
	type FeatureRow,
	getAdminAccountById,
	getAdminAccountByUsername,
	getSessionById,
	getSessionByTokenHash,
	getWorkspace,
	type ProjectRow,
	type PullRequestRow,
	type ReleaseRow,
	revokeSessionById,
	revokeSessionsForAdmin,
	type SessionRow,
	type TaskApprovalRow,
	updateAdminPasswordHash,
	type WorkspaceRow,
} from "./repositories/core-repositories";
export {
	type ActivityEventRow,
	type AuditEventRow,
	appendActivityEvent,
	appendAuditEvent,
	appendDiagnosticLogChunk,
	appendFailureRecord,
	appendProgressSnapshot,
	claimOutboxIntent,
	claimScheduledReconciliation,
	createDevelopmentAttempt,
	createIdempotencyRecord,
	createOutboxIntent,
	createScheduledReconciliation,
	createWorkerRegistration,
	type DevelopmentAttemptRow,
	type DiagnosticLogChunkRow,
	type FailureRecordRow,
	getDevelopmentAttempt,
	heartbeatWorker,
	type IdempotencyRecordRow,
	type OutboxIntentRow,
	type ProgressSnapshotRow,
	renewLease,
	type ScheduledReconciliationRow,
	updateAttemptStatus,
	type WorkerRegistrationRow,
} from "./repositories/workflow-repositories";
export {
	applyCoreMigration,
	CORE_VERSION,
	rollbackCoreMigration,
} from "./schema/core-migration";
export {
	type AuditActorType,
	auditActorTypes,
	type DiagnosticStream,
	diagnosticStreams,
	type FeatureState,
	featureStates,
	type JobAttemptStatus,
	jobAttemptStatuses,
	type OutboxStatus,
	outboxStatuses,
	type ProjectStatus,
	type PullRequestObservedState,
	projectStatuses,
	pullRequestObservedStates,
	type ReleaseStatus,
	releaseStatuses,
	type ScheduleStatus,
	scheduleStatuses,
} from "./schema/enums";
export {
	applyWorkflowMigration,
	rollbackWorkflowMigration,
	WORKFLOW_VERSION,
} from "./schema/workflow-migration";
export { createDatabaseFixture, type DatabaseFixture } from "./testing/database-fixture";

export const packageName = "@autopilot-console/database" as const;
