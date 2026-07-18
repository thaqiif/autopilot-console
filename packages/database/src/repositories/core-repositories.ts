import type postgres from "postgres";
import type { Queryable } from "../client";
import type { FeatureState, ProjectStatus, ReleaseStatus } from "../schema/enums";

export interface WorkspaceRow {
	id: string;
	name: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface AdminAccountRow {
	id: string;
	username: string;
	passwordHash: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface SessionRow {
	id: string;
	adminAccountId: string;
	tokenHash: string;
	expiresAt: Date;
	revokedAt: Date | null;
	createdAt: Date;
}

export interface ProjectRow {
	id: string;
	workspaceId: string;
	name: string;
	slug: string;
	description: string | null;
	githubOwner: string;
	githubRepo: string;
	canonicalPath: string;
	developmentBranch: string;
	validationStatus: string | null;
	lastValidatedAt: Date | null;
	status: ProjectStatus;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ReleaseRow {
	id: string;
	projectId: string;
	name: string;
	version: string;
	description: string | null;
	sortOrder: number;
	status: ReleaseStatus;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface FeatureRow {
	id: string;
	projectId: string;
	releaseId: string;
	slug: string;
	title: string;
	summary: string | null;
	state: FeatureState;
	branchName: string;
	taskPath: string | null;
	rowVersion: number;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface TaskApprovalRow {
	id: string;
	projectId: string;
	featureId: string;
	relativeTaskPath: string;
	checksum: string;
	schemaCompatibilityVersion: string;
	requirementsSnapshot: unknown;
	approvedByAdminId: string;
	approvedAt: Date;
	invalidatedAt: Date | null;
	createdAt: Date;
}

export interface PullRequestRow {
	id: string;
	projectId: string;
	featureId: string;
	repositoryOwner: string;
	repositoryName: string;
	number: number;
	url: string;
	headBranch: string;
	baseBranch: string;
	originalHeadSha: string;
	observedHeadSha: string | null;
	observedState: string | null;
	mergeCommitSha: string | null;
	lastObservedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

function mapWorkspace(row: Record<string, unknown>): WorkspaceRow {
	return {
		id: row.id as string,
		name: row.name as string,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapAdmin(row: Record<string, unknown>): AdminAccountRow {
	return {
		id: row.id as string,
		username: row.username as string,
		passwordHash: row.password_hash as string,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapSession(row: Record<string, unknown>): SessionRow {
	return {
		id: row.id as string,
		adminAccountId: row.admin_account_id as string,
		tokenHash: row.token_hash as string,
		expiresAt: row.expires_at as Date,
		revokedAt: (row.revoked_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
	};
}

function mapProject(row: Record<string, unknown>): ProjectRow {
	return {
		id: row.id as string,
		workspaceId: row.workspace_id as string,
		name: row.name as string,
		slug: row.slug as string,
		description: (row.description as string | null) ?? null,
		githubOwner: row.github_owner as string,
		githubRepo: row.github_repo as string,
		canonicalPath: row.canonical_path as string,
		developmentBranch: row.development_branch as string,
		validationStatus: (row.validation_status as string | null) ?? null,
		lastValidatedAt: (row.last_validated_at as Date | null) ?? null,
		status: row.status as ProjectStatus,
		archivedAt: (row.archived_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapRelease(row: Record<string, unknown>): ReleaseRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		name: row.name as string,
		version: row.version as string,
		description: (row.description as string | null) ?? null,
		sortOrder: row.sort_order as number,
		status: row.status as ReleaseStatus,
		archivedAt: (row.archived_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapFeature(row: Record<string, unknown>): FeatureRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		releaseId: row.release_id as string,
		slug: row.slug as string,
		title: row.title as string,
		summary: (row.summary as string | null) ?? null,
		state: row.state as FeatureState,
		branchName: row.branch_name as string,
		taskPath: (row.task_path as string | null) ?? null,
		rowVersion: row.row_version as number,
		archivedAt: (row.archived_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapTaskApproval(row: Record<string, unknown>): TaskApprovalRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: row.feature_id as string,
		relativeTaskPath: row.relative_task_path as string,
		checksum: row.checksum as string,
		schemaCompatibilityVersion: row.schema_compatibility_version as string,
		requirementsSnapshot: row.requirements_snapshot,
		approvedByAdminId: row.approved_by_admin_id as string,
		approvedAt: row.approved_at as Date,
		invalidatedAt: (row.invalidated_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
	};
}

function mapPullRequest(row: Record<string, unknown>): PullRequestRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: row.feature_id as string,
		repositoryOwner: row.repository_owner as string,
		repositoryName: row.repository_name as string,
		number: row.number as number,
		url: row.url as string,
		headBranch: row.head_branch as string,
		baseBranch: row.base_branch as string,
		originalHeadSha: row.original_head_sha as string,
		observedHeadSha: (row.observed_head_sha as string | null) ?? null,
		observedState: (row.observed_state as string | null) ?? null,
		mergeCommitSha: (row.merge_commit_sha as string | null) ?? null,
		lastObservedAt: (row.last_observed_at as Date | null) ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

export async function createWorkspace(sql: Queryable): Promise<WorkspaceRow> {
	const existing = await sql`SELECT * FROM workspaces LIMIT 1`;
	if (existing[0]) return mapWorkspace(existing[0] as Record<string, unknown>);
	const rows = await sql`
		INSERT INTO workspaces (name)
		VALUES ('default')
		RETURNING *
	`;
	return mapWorkspace(rows[0] as Record<string, unknown>);
}

export async function getWorkspace(sql: Queryable): Promise<WorkspaceRow | null> {
	const rows = await sql`SELECT * FROM workspaces LIMIT 1`;
	return rows[0] ? mapWorkspace(rows[0] as Record<string, unknown>) : null;
}

export async function createAdminAccount(
	sql: Queryable,
	input: { username: string; passwordHash: string },
): Promise<AdminAccountRow> {
	const rows = await sql`
		INSERT INTO admin_accounts (username, password_hash)
		VALUES (${input.username}, ${input.passwordHash})
		RETURNING *
	`;
	return mapAdmin(rows[0] as Record<string, unknown>);
}

export async function createSession(
	sql: Queryable,
	input: { adminAccountId: string; tokenHash: string; expiresAt: Date },
): Promise<SessionRow> {
	const rows = await sql`
		INSERT INTO sessions (admin_account_id, token_hash, expires_at)
		VALUES (${input.adminAccountId}, ${input.tokenHash}, ${input.expiresAt})
		RETURNING *
	`;
	return mapSession(rows[0] as Record<string, unknown>);
}

export async function createProject(
	sql: Queryable,
	input: {
		workspaceId: string;
		name: string;
		slug: string;
		githubOwner: string;
		githubRepo: string;
		canonicalPath: string;
		developmentBranch: string;
		description?: string;
	},
): Promise<ProjectRow> {
	const rows = await sql`
		INSERT INTO projects (
			workspace_id, name, slug, description, github_owner, github_repo,
			canonical_path, development_branch
		)
		VALUES (
			${input.workspaceId},
			${input.name},
			${input.slug},
			${input.description ?? null},
			${input.githubOwner},
			${input.githubRepo},
			${input.canonicalPath},
			${input.developmentBranch}
		)
		RETURNING *
	`;
	return mapProject(rows[0] as Record<string, unknown>);
}

export async function createRelease(
	sql: Queryable,
	input: {
		projectId: string;
		name: string;
		version: string;
		sortOrder: number;
		description?: string;
	},
): Promise<ReleaseRow> {
	const rows = await sql`
		INSERT INTO releases (project_id, name, version, description, sort_order)
		VALUES (
			${input.projectId},
			${input.name},
			${input.version},
			${input.description ?? null},
			${input.sortOrder}
		)
		RETURNING *
	`;
	return mapRelease(rows[0] as Record<string, unknown>);
}

export async function createFeature(
	sql: Queryable,
	input: {
		projectId: string;
		releaseId: string;
		slug: string;
		title: string;
		branchName: string;
		summary?: string;
	},
): Promise<FeatureRow> {
	const rows = await sql`
		INSERT INTO features (project_id, release_id, slug, title, summary, branch_name)
		VALUES (
			${input.projectId},
			${input.releaseId},
			${input.slug},
			${input.title},
			${input.summary ?? null},
			${input.branchName}
		)
		RETURNING *
	`;
	return mapFeature(rows[0] as Record<string, unknown>);
}

export async function createTaskApproval(
	sql: Queryable,
	input: {
		projectId: string;
		featureId: string;
		relativeTaskPath: string;
		checksum: string;
		schemaCompatibilityVersion: string;
		requirementsSnapshot: unknown;
		approvedByAdminId: string;
	},
): Promise<TaskApprovalRow> {
	const rows = await sql`
		INSERT INTO task_approvals (
			project_id, feature_id, relative_task_path, checksum,
			schema_compatibility_version, requirements_snapshot, approved_by_admin_id
		)
		VALUES (
			${input.projectId},
			${input.featureId},
			${input.relativeTaskPath},
			${input.checksum},
			${input.schemaCompatibilityVersion},
			${sql.json(input.requirementsSnapshot as postgres.JSONValue)},
			${input.approvedByAdminId}
		)
		RETURNING *
	`;
	return mapTaskApproval(rows[0] as Record<string, unknown>);
}

export async function createPullRequestIdentity(
	sql: Queryable,
	input: {
		projectId: string;
		featureId: string;
		repositoryOwner: string;
		repositoryName: string;
		number: number;
		url: string;
		headBranch: string;
		baseBranch: string;
		originalHeadSha: string;
	},
): Promise<PullRequestRow> {
	const rows = await sql`
		INSERT INTO pull_requests (
			project_id, feature_id, repository_owner, repository_name,
			number, url, head_branch, base_branch, original_head_sha
		)
		VALUES (
			${input.projectId},
			${input.featureId},
			${input.repositoryOwner},
			${input.repositoryName},
			${input.number},
			${input.url},
			${input.headBranch},
			${input.baseBranch},
			${input.originalHeadSha}
		)
		RETURNING *
	`;
	return mapPullRequest(rows[0] as Record<string, unknown>);
}
