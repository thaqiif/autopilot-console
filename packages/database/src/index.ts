/**
 * @autopilot-console/database
 * PostgreSQL client, migrations, schema, and repositories.
 */

export { createDatabaseClient, type DatabaseClient, type Sql, type TransactionSql } from "./client";
export {
	type AdminAccountRow,
	createAdminAccount,
	createFeature,
	createProject,
	createPullRequestIdentity,
	createRelease,
	createSession,
	createTaskApproval,
	createWorkspace,
	type FeatureRow,
	getWorkspace,
	type ProjectRow,
	type PullRequestRow,
	type ReleaseRow,
	type SessionRow,
	type TaskApprovalRow,
	type WorkspaceRow,
} from "./repositories/core-repositories";
export {
	applyCoreMigration,
	CORE_VERSION,
	rollbackCoreMigration,
} from "./schema/core-migration";
export {
	type FeatureState,
	featureStates,
	type ProjectStatus,
	type PullRequestObservedState,
	projectStatuses,
	pullRequestObservedStates,
	type ReleaseStatus,
	releaseStatuses,
} from "./schema/enums";
export { createDatabaseFixture, type DatabaseFixture } from "./testing/database-fixture";

export const packageName = "@autopilot-console/database" as const;
