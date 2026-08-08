/**
 * Attention route for the Needs Your Attention queue (requirement 23).
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import {
	ATTENTION_CATEGORIES,
	type AttentionCategory,
	deriveAttentionForFeatures,
} from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface AttentionRouteOptions {
	sql: Queryable;
}

export function createAttentionRoutes(options: AttentionRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/attention", async (c) => {
		const category = c.req.query("category") as AttentionCategory | undefined;
		const projectId = c.req.query("projectId");
		const releaseId = c.req.query("releaseId");
		if (category && !ATTENTION_CATEGORIES.includes(category)) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Unsupported attention category.",
				httpStatus: 400,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		const features = await options.sql`
			SELECT
				f.id,
				f.project_id,
				f.release_id,
				f.state,
				f.updated_at,
				stale.occurred_at AS stale_since
			FROM features f
			JOIN projects p ON p.id = f.project_id
			LEFT JOIN LATERAL (
				SELECT fr.occurred_at
				FROM failure_records fr
				WHERE fr.feature_id = f.id
					AND fr.category = 'stale_github_sync'
					AND NOT EXISTS (
						SELECT 1
						FROM pull_requests observed
						WHERE observed.feature_id = f.id
							AND observed.last_observed_at >= fr.occurred_at
					)
				ORDER BY fr.occurred_at DESC, fr.id DESC
				LIMIT 1
			) stale ON true
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
					OR stale.occurred_at IS NOT NULL
				)
			ORDER BY COALESCE(stale.occurred_at, f.updated_at) DESC, f.id DESC
		`;

		const filtered = features.filter(
			(feature) =>
				(!projectId || feature.project_id === projectId) &&
				(!releaseId || feature.release_id === releaseId),
		);
		const attentionInputs = filtered.map((feature) => {
			const staleSince = feature.stale_since as Date | null;
			return {
				projectId: feature.project_id as string,
				releaseId: feature.release_id as string,
				featureId: feature.id as string,
				state: feature.state as Parameters<typeof deriveAttentionForFeatures>[0][number]["state"],
				stateChangedAt: (feature.updated_at as Date).toISOString(),
				staleGithubSync: staleSince !== null,
				...(staleSince ? { staleSince: staleSince.toISOString() } : {}),
			};
		});
		let items = deriveAttentionForFeatures(attentionInputs);

		if (category) {
			items = items.filter((item) => item.category === category);
		}

		return c.json({
			ok: true as const,
			data: { items },
		});
	});

	return app;
}
