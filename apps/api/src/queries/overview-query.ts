/**
 * Overview query for the portfolio dashboard (requirement 23).
 *
 * Aggregates cross-project metrics: project count, active/queued jobs,
 * attention items, failed/interrupted jobs, PRs awaiting review,
 * and development-merged feature/release counts.
 */

import type { Queryable } from "../../../../packages/database/src/client";

export interface OverviewMetrics {
	projectCount: number;
	activeJobs: number;
	queuedJobs: number;
	attentionCount: number;
	failedJobs: number;
	prsAwaitingReview: number;
	developmentMergedFeatures: number;
	developmentMergedReleases: number;
}

export async function queryOverview(sql: Queryable): Promise<OverviewMetrics> {
	const [projectRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM projects
		WHERE status = 'active' AND archived_at IS NULL
	`;

	const [activeJobsRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM development_job_attempts
		WHERE status = 'RUNNING'
	`;

	const [queuedJobsRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM development_job_attempts
		WHERE status = 'QUEUED'
	`;

	// Attention: count features in states that require attention
	const [attentionRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM features f
		WHERE f.archived_at IS NULL
		AND f.state IN (
			'TASKS_REVIEW',
			'DEVELOPMENT_FAILED',
			'DEVELOPMENT_INTERRUPTED',
			'PR_CREATION_FAILED',
			'CI_FAILED',
			'PR_REVIEW',
			'PR_CHANGES_REQUESTED',
			'BLOCKED'
		)
	`;

	const [failedJobsRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM development_job_attempts
		WHERE status IN ('FAILED', 'INTERRUPTED')
	`;

	const [prsRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM pull_requests pr
		JOIN features f ON f.id = pr.feature_id
		WHERE f.archived_at IS NULL
		AND pr.observed_state = 'open'
		AND f.state IN ('PR_REVIEW', 'CI_RUNNING')
	`;

	const [mergedFeaturesRow] = await sql`
		SELECT COUNT(*)::int AS count
		FROM features
		WHERE archived_at IS NULL AND state = 'DEVELOPMENT_MERGED'
	`;

	const [mergedReleasesRow] = await sql`
		SELECT COUNT(DISTINCT r.id)::int AS count
		FROM releases r
		WHERE r.archived_at IS NULL
		AND EXISTS (
			SELECT 1 FROM features f
			WHERE f.release_id = r.id
			AND f.archived_at IS NULL
			AND f.state = 'DEVELOPMENT_MERGED'
		)
	`;

	return {
		projectCount: (projectRow?.count as number) ?? 0,
		activeJobs: (activeJobsRow?.count as number) ?? 0,
		queuedJobs: (queuedJobsRow?.count as number) ?? 0,
		attentionCount: (attentionRow?.count as number) ?? 0,
		failedJobs: (failedJobsRow?.count as number) ?? 0,
		prsAwaitingReview: (prsRow?.count as number) ?? 0,
		developmentMergedFeatures: (mergedFeaturesRow?.count as number) ?? 0,
		developmentMergedReleases: (mergedReleasesRow?.count as number) ?? 0,
	};
}
