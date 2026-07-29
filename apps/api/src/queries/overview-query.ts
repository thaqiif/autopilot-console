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
	const [row] = await sql`
		SELECT
			(
				SELECT COUNT(*)::int
				FROM projects
				WHERE status = 'active' AND archived_at IS NULL
			) AS project_count,
			(
				SELECT COUNT(*)::int
				FROM development_job_attempts a
				JOIN features f ON f.id = a.feature_id
				JOIN projects p ON p.id = a.project_id
				WHERE a.status = 'RUNNING'
					AND f.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
			) AS active_jobs,
			(
				SELECT COUNT(*)::int
				FROM development_job_attempts a
				JOIN features f ON f.id = a.feature_id
				JOIN projects p ON p.id = a.project_id
				WHERE a.status = 'QUEUED'
					AND f.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
			) AS queued_jobs,
			(
				SELECT COUNT(*)::int
				FROM features f
				JOIN projects p ON p.id = f.project_id
				WHERE f.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
					AND (
						f.state IN (
							'TASKS_REVIEW',
							'DEVELOPMENT_FAILED',
							'DEVELOPMENT_INTERRUPTED',
							'PR_CREATION_FAILED',
							'CI_FAILED',
							'PR_REVIEW',
							'PR_CHANGES_REQUESTED',
							'BLOCKED'
						)
						OR EXISTS (
							SELECT 1
							FROM failure_records fr
							WHERE fr.feature_id = f.id
								AND fr.category = 'stale_github_sync'
								AND NOT EXISTS (
									SELECT 1
									FROM pull_requests observed
									WHERE observed.feature_id = f.id
										AND observed.last_observed_at >= fr.occurred_at
								)
						)
					)
			) AS attention_count,
			(
				SELECT COUNT(*)::int
				FROM development_job_attempts a
				JOIN features f ON f.id = a.feature_id
				JOIN projects p ON p.id = a.project_id
				WHERE a.status IN ('FAILED', 'INTERRUPTED')
					AND f.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
			) AS failed_jobs,
			(
				SELECT COUNT(*)::int
				FROM pull_requests pr
				JOIN features f ON f.id = pr.feature_id
				JOIN projects p ON p.id = pr.project_id
				WHERE f.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
					AND pr.observed_state = 'open'
					AND f.state = 'PR_REVIEW'
			) AS prs_awaiting_review,
			(
				SELECT COUNT(*)::int
				FROM features f
				JOIN projects p ON p.id = f.project_id
				WHERE f.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
					AND f.state = 'DEVELOPMENT_MERGED'
			) AS development_merged_features,
			(
				SELECT COUNT(*)::int
				FROM releases r
				JOIN projects p ON p.id = r.project_id
				WHERE r.archived_at IS NULL
					AND p.status = 'active'
					AND p.archived_at IS NULL
					AND r.status = 'DEVELOPMENT_MERGED'
			) AS development_merged_releases
	`;

	return {
		projectCount: (row?.project_count as number) ?? 0,
		activeJobs: (row?.active_jobs as number) ?? 0,
		queuedJobs: (row?.queued_jobs as number) ?? 0,
		attentionCount: (row?.attention_count as number) ?? 0,
		failedJobs: (row?.failed_jobs as number) ?? 0,
		prsAwaitingReview: (row?.prs_awaiting_review as number) ?? 0,
		developmentMergedFeatures: (row?.development_merged_features as number) ?? 0,
		developmentMergedReleases: (row?.development_merged_releases as number) ?? 0,
	};
}
