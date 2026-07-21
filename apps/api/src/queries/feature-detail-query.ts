/**
 * Feature detail query for requirement 23.
 *
 * Reconstructs full feature context: task approval, progress, attempts,
 * failures, bounded logs, PR status, and recent activity.
 */

import type { Queryable } from "../../../../packages/database/src/client";

export interface FeatureDetail {
	id: string;
	projectId: string;
	releaseId: string;
	slug: string;
	title: string;
	summary: string | null;
	state: string;
	branchName: string;
	taskPath: string | null;
	rowVersion: number;
	createdAt: Date;
	updatedAt: Date;
	taskApproval: {
		id: string;
		relativeTaskPath: string;
		checksum: string;
		requirementsSnapshot: unknown;
		approvedAt: Date;
	} | null;
	progress: {
		totalRequirements: number;
		passedRequirements: number;
		activeRequirements: number;
		stuckRequirements: number;
		invalidRequirements: number;
		remainingRequirements: number;
		lastUpdatedAt: Date | null;
	} | null;
	attempts: Array<{
		id: string;
		status: string;
		branchName: string;
		workerRegistrationId: string | null;
		processPid: number | null;
		heartbeatAt: Date | null;
		enqueuedAt: Date;
		startedAt: Date | null;
		endedAt: Date | null;
		exitCode: number | null;
		structuredResult: unknown | null;
	}>;
	failures: Array<{
		id: string;
		attemptId: string | null;
		category: string;
		summary: string;
		recommendedAction: string;
		occurredAt: Date;
	}>;
	diagnosticLogs: Array<{
		id: string;
		attemptId: string;
		sequence: number;
		stream: string;
		body: string;
		truncated: boolean;
		createdAt: Date;
	}>;
	pullRequest: {
		id: string;
		number: number;
		url: string;
		headBranch: string;
		baseBranch: string;
		observedState: string | null;
		observedHeadSha: string | null;
		mergeCommitSha: string | null;
		lastObservedAt: Date | null;
	} | null;
	recentActivity: Array<{
		id: string;
		type: string;
		summary: string;
		occurredAt: Date;
	}>;
}

export async function queryFeatureDetail(
	sql: Queryable,
	featureId: string,
): Promise<FeatureDetail | null> {
	const [feature] = await sql`
		SELECT *
		FROM features
		WHERE id = ${featureId}
	`;

	if (!feature) return null;

	// Get latest task approval
	const [approval] = await sql`
		SELECT id, relative_task_path, checksum, requirements_snapshot, approved_at
		FROM task_approvals
		WHERE feature_id = ${featureId} AND invalidated_at IS NULL
		ORDER BY approved_at DESC
		LIMIT 1
	`;

	// Get latest progress snapshot
	const [progress] = await sql`
		SELECT summary, requirements, created_at
		FROM progress_snapshots
		WHERE feature_id = ${featureId}
		ORDER BY created_at DESC
		LIMIT 1
	`;

	// Get all attempts
	const attempts = await sql`
		SELECT id, status, branch_name, worker_registration_id, process_pid,
			heartbeat_at, enqueued_at, started_at, ended_at, exit_code, structured_result
		FROM development_job_attempts
		WHERE feature_id = ${featureId}
		ORDER BY enqueued_at DESC
	`;

	// Get failures
	const failures = await sql`
		SELECT id, attempt_id, category, summary, recommended_action, occurred_at
		FROM failure_records
		WHERE feature_id = ${featureId}
		ORDER BY occurred_at DESC
		LIMIT 50
	`;

	// Get diagnostic logs (bounded to latest 100)
	const diagnosticLogs = await sql`
		SELECT dl.id, dl.attempt_id, dl.sequence, dl.stream, dl.body, dl.truncated, dl.created_at
		FROM diagnostic_log_chunks dl
		JOIN development_job_attempts da ON da.id = dl.attempt_id
		WHERE da.feature_id = ${featureId}
		ORDER BY dl.created_at DESC
		LIMIT 100
	`;

	// Get PR if exists
	const [pr] = await sql`
		SELECT id, number, url, head_branch, base_branch, observed_state,
			observed_head_sha, merge_commit_sha, last_observed_at
		FROM pull_requests
		WHERE feature_id = ${featureId}
		ORDER BY created_at DESC
		LIMIT 1
	`;

	// Get recent activity
	const recentActivity = await sql`
		SELECT id, type, summary, occurred_at
		FROM activity_events
		WHERE feature_id = ${featureId}
		ORDER BY occurred_at DESC
		LIMIT 50
	`;

	// Parse progress if available
	let progressSummary = null;
	if (progress) {
		const requirements = progress.requirements as Array<Record<string, unknown>>;
		progressSummary = {
			totalRequirements: requirements?.length ?? 0,
			passedRequirements: requirements?.filter((r) => r.passes === true).length ?? 0,
			activeRequirements:
				requirements?.filter(
					(r) =>
						r.tdd &&
						(r.tdd as Record<string, unknown>).test &&
						!((r.tdd as Record<string, unknown>).test as Record<string, unknown>).passes &&
						((r.tdd as Record<string, unknown>).implement as Record<string, unknown>)?.passes !==
							false,
				).length ?? 0,
			stuckRequirements: requirements?.filter((r) => r.stuck === true).length ?? 0,
			invalidRequirements: requirements?.filter((r) => r.invalidTest === true).length ?? 0,
			remainingRequirements:
				requirements?.filter((r) => r.passes !== true && r.stuck !== true && r.invalidTest !== true)
					.length ?? 0,
			lastUpdatedAt: progress.created_at as Date,
		};
	}

	return {
		id: feature.id as string,
		projectId: feature.project_id as string,
		releaseId: feature.release_id as string,
		slug: feature.slug as string,
		title: feature.title as string,
		summary: (feature.summary as string) ?? null,
		state: feature.state as string,
		branchName: feature.branch_name as string,
		taskPath: (feature.task_path as string) ?? null,
		rowVersion: feature.row_version as number,
		createdAt: feature.created_at as Date,
		updatedAt: feature.updated_at as Date,
		taskApproval: approval
			? {
					id: approval.id as string,
					relativeTaskPath: approval.relative_task_path as string,
					checksum: approval.checksum as string,
					requirementsSnapshot: approval.requirements_snapshot,
					approvedAt: approval.approved_at as Date,
				}
			: null,
		progress: progressSummary,
		attempts: attempts.map((a) => ({
			id: a.id as string,
			status: a.status as string,
			branchName: a.branch_name as string,
			workerRegistrationId: (a.worker_registration_id as string) ?? null,
			processPid: (a.process_pid as number) ?? null,
			heartbeatAt: (a.heartbeat_at as Date) ?? null,
			enqueuedAt: a.enqueued_at as Date,
			startedAt: (a.started_at as Date) ?? null,
			endedAt: (a.ended_at as Date) ?? null,
			exitCode: (a.exit_code as number) ?? null,
			structuredResult: a.structured_result ?? null,
		})),
		failures: failures.map((f) => ({
			id: f.id as string,
			attemptId: (f.attempt_id as string) ?? null,
			category: f.category as string,
			summary: f.summary as string,
			recommendedAction: f.recommended_action as string,
			occurredAt: f.occurred_at as Date,
		})),
		diagnosticLogs: diagnosticLogs.map((dl) => ({
			id: dl.id as string,
			attemptId: dl.attempt_id as string,
			sequence: dl.sequence as number,
			stream: dl.stream as string,
			body: dl.body as string,
			truncated: dl.truncated as boolean,
			createdAt: dl.created_at as Date,
		})),
		pullRequest: pr
			? {
					id: pr.id as string,
					number: pr.number as number,
					url: pr.url as string,
					headBranch: pr.head_branch as string,
					baseBranch: pr.base_branch as string,
					observedState: (pr.observed_state as string) ?? null,
					observedHeadSha: (pr.observed_head_sha as string) ?? null,
					mergeCommitSha: (pr.merge_commit_sha as string) ?? null,
					lastObservedAt: (pr.last_observed_at as Date) ?? null,
				}
			: null,
		recentActivity: recentActivity.map((a) => ({
			id: a.id as string,
			type: a.type as string,
			summary: a.summary as string,
			occurredAt: a.occurred_at as Date,
		})),
	};
}
