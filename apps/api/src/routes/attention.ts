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

export interface AttentionRouteOptions {
	sql: Queryable;
}

export function createAttentionRoutes(options: AttentionRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/attention", async (c) => {
		const category = c.req.query("category") as AttentionCategory | undefined;

		// Get features that need attention
		const features = await options.sql`
			SELECT f.id, f.project_id, f.release_id, f.state, f.updated_at,
				f.archived_at
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

		// Map to attention inputs
		const attentionInputs = features.map((f) => ({
			projectId: f.project_id as string,
			releaseId: f.release_id as string | undefined,
			featureId: f.id as string,
			state: f.state as string,
			stateChangedAt: (f.updated_at as Date).toISOString(),
		}));

		// Derive attention items
		let items = deriveAttentionForFeatures(
			attentionInputs as Parameters<typeof deriveAttentionForFeatures>[0],
		);

		// Apply category filter if provided
		if (category && ATTENTION_CATEGORIES.includes(category)) {
			items = items.filter((item) => item.category === category);
		}

		return c.json({ ok: true as const, data: { items } });
	});

	return app;
}
