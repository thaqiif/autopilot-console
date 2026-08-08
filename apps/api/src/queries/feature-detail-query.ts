/**
 * Feature detail query for requirement 23.
 *
 * Reconstructs full feature context: task approval, progress, attempts,
 * failures, bounded logs, PR status, and recent activity.
 */

import type { Queryable } from "../../../../packages/database/src/client";

export interface RequirementProgress {
	id: string;
	description: string;
	acceptance: string[];
	dependsOn: string[];
	blockedReason: string | null;
	status: "not_started" | "in_progress" | "passed" | "stuck" | "invalid";
	passes: boolean;
	stuck: boolean;
	invalidTest: boolean;
	phases: {
		red: boolean;
		green: boolean;
		refactor: boolean;
	};
}

export interface FeatureAttempt {
	id: string;
	status: string;
	branchName: string;
	predecessorAttemptId: string | null;
	workerRegistrationId: string | null;
	worker: {
		workerId: string;
		hostname: string;
		capacity: number;
		activeJobs: number;
		lastHeartbeatAt: Date;
	} | null;
	processPid: number | null;
	heartbeatAt: Date | null;
	enqueuedAt: Date;
	startedAt: Date | null;
	endedAt: Date | null;
	exitCode: number | null;
	structuredResult: unknown | null;
}

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
		activeRequirementId: string | null;
		requirements: RequirementProgress[];
		lastUpdatedAt: Date | null;
	} | null;
	activeAttempt: FeatureAttempt | null;
	attempts: FeatureAttempt[];
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
		SELECT
			a.id,
			a.status,
			a.branch_name,
			a.predecessor_attempt_id,
			a.worker_registration_id,
			a.process_pid,
			a.heartbeat_at,
			a.enqueued_at,
			a.started_at,
			a.ended_at,
			a.exit_code,
			a.structured_result,
			w.worker_id,
			w.hostname AS worker_hostname,
			w.capacity AS worker_capacity,
			w.active_jobs AS worker_active_jobs,
			w.last_heartbeat_at AS worker_last_heartbeat_at
		FROM development_job_attempts a
		LEFT JOIN worker_registrations w ON w.id = a.worker_registration_id
		WHERE a.feature_id = ${featureId}
		ORDER BY a.enqueued_at DESC, a.id DESC
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

	let progressSummary: FeatureDetail["progress"] = null;
	if (progress) {
		const requirements = Array.isArray(progress.requirements)
			? progress.requirements.map(mapRequirementProgress)
			: [];
		const summary = asRecord(progress.summary);
		const activeRequirementId =
			typeof summary.activeRequirementId === "string"
				? summary.activeRequirementId
				: (requirements.find((requirement) => requirement.status === "in_progress")?.id ?? null);
		progressSummary = {
			totalRequirements: requirements.length,
			passedRequirements: requirements.filter((requirement) => requirement.status === "passed")
				.length,
			activeRequirements: requirements.filter((requirement) => requirement.status === "in_progress")
				.length,
			stuckRequirements: requirements.filter((requirement) => requirement.status === "stuck")
				.length,
			invalidRequirements: requirements.filter((requirement) => requirement.status === "invalid")
				.length,
			remainingRequirements: requirements.filter(
				(requirement) =>
					requirement.status === "not_started" || requirement.status === "in_progress",
			).length,
			activeRequirementId,
			requirements,
			lastUpdatedAt: progress.created_at as Date,
		};
	}

	const mappedAttempts = attempts.map(mapAttempt);

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
		activeAttempt:
			mappedAttempts.find(
				(attempt) =>
					attempt.status === "RUNNING" ||
					attempt.status === "CANCEL_REQUESTED" ||
					attempt.status === "QUEUED",
			) ?? null,
		attempts: mappedAttempts,
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
			sequence: Number(dl.sequence),
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

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function phasePasses(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	return asRecord(value).passes === true;
}

function deriveRequirementStatus(
	passes: boolean,
	stuck: boolean,
	invalidTest: boolean,
	started: boolean,
): RequirementProgress["status"] {
	if (passes) return "passed";
	if (stuck) return "stuck";
	if (invalidTest) return "invalid";
	return started ? "in_progress" : "not_started";
}

function mapRequirementProgress(value: unknown): RequirementProgress {
	const requirement = asRecord(value);
	const tdd = asRecord(requirement.tdd);
	const passes = requirement.passes === true;
	const stuck = requirement.stuck === true;
	const invalidTest = requirement.invalidTest === true;
	const phases = {
		red: phasePasses(tdd.test),
		green: phasePasses(tdd.implement),
		refactor: phasePasses(tdd.refactor),
	};
	const started =
		requirement.status === "in_progress" || phases.red || phases.green || phases.refactor;
	const status = deriveRequirementStatus(passes, stuck, invalidTest, started);

	return {
		id: String(requirement.id ?? ""),
		description: typeof requirement.description === "string" ? requirement.description : "",
		acceptance: Array.isArray(requirement.acceptance) ? requirement.acceptance.map(String) : [],
		dependsOn: Array.isArray(requirement.dependsOn) ? requirement.dependsOn.map(String) : [],
		blockedReason:
			typeof requirement.blockedReason === "string"
				? requirement.blockedReason
				: typeof requirement.stuckReason === "string"
					? requirement.stuckReason
					: null,
		status,
		passes,
		stuck,
		invalidTest,
		phases,
	};
}

function mapAttempt(attempt: Record<string, unknown>): FeatureAttempt {
	const workerId = attempt.worker_id as string | null;
	return {
		id: attempt.id as string,
		status: attempt.status as string,
		branchName: attempt.branch_name as string,
		predecessorAttemptId: (attempt.predecessor_attempt_id as string) ?? null,
		workerRegistrationId: (attempt.worker_registration_id as string) ?? null,
		worker: workerId
			? {
					workerId,
					hostname: attempt.worker_hostname as string,
					capacity: attempt.worker_capacity as number,
					activeJobs: attempt.worker_active_jobs as number,
					lastHeartbeatAt: attempt.worker_last_heartbeat_at as Date,
				}
			: null,
		processPid: (attempt.process_pid as number) ?? null,
		heartbeatAt: (attempt.heartbeat_at as Date) ?? null,
		enqueuedAt: attempt.enqueued_at as Date,
		startedAt: (attempt.started_at as Date) ?? null,
		endedAt: (attempt.ended_at as Date) ?? null,
		exitCode: (attempt.exit_code as number) ?? null,
		structuredResult: attempt.structured_result ?? null,
	};
}
