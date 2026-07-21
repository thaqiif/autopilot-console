/**
 * Release read routes (requirement 23).
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import {
	computeDevelopmentProgress,
	type FeatureState,
} from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface ReleaseReadRouteOptions {
	sql: Queryable;
}

export function createReleaseReadRoutes(options: ReleaseReadRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/releases", async (c) => {
		const releases = await options.sql`
			SELECT r.id, r.project_id, p.name AS project_name, r.name, r.version,
				r.description, r.sort_order, r.status, r.archived_at, r.created_at, r.updated_at
			FROM releases r
			JOIN projects p ON p.id = r.project_id
			WHERE r.archived_at IS NULL AND p.archived_at IS NULL
			ORDER BY r.sort_order ASC, r.created_at DESC
		`;
		const featureRows = await options.sql`
			SELECT id, release_id, state, archived_at
			FROM features
			WHERE archived_at IS NULL
		`;
		return c.json({
			ok: true as const,
			data: releases.map((release) => {
				const features = featureRows.filter((feature) => feature.release_id === release.id);
				return {
					id: release.id,
					projectId: release.project_id,
					projectName: release.project_name,
					name: release.name,
					version: release.version,
					description: release.description,
					sortOrder: release.sort_order,
					status: release.status,
					createdAt: release.created_at,
					updatedAt: release.updated_at,
					developmentProgress: computeDevelopmentProgress(
						features.map((feature) => ({
							id: feature.id as string,
							state: feature.state as FeatureState,
							archived: false,
						})),
					),
				};
			}),
		});
	});

	app.get("/api/releases/:id", async (c) => {
		const { id } = c.req.param();

		const [release] = await options.sql`
			SELECT id, project_id, name, version, description, sort_order, status, archived_at, created_at, updated_at
			FROM releases
			WHERE id = ${id}
		`;

		if (!release) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Release not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		// Get features
		const features = await options.sql`
			SELECT id, slug, title, summary, state, branch_name, task_path, row_version, archived_at, created_at, updated_at
			FROM features
			WHERE release_id = ${id}
			ORDER BY created_at ASC
		`;

		// Compute development progress
		const progress = computeDevelopmentProgress(
			features.map((f) => ({
				id: f.id as string,
				state: f.state as FeatureState,
				archived: f.archived_at !== null,
			})),
		);

		return c.json({
			ok: true as const,
			data: {
				id: release.id,
				projectId: release.project_id,
				name: release.name,
				version: release.version,
				description: release.description,
				sortOrder: release.sort_order,
				status: release.status,
				archivedAt: release.archived_at,
				createdAt: release.created_at,
				updatedAt: release.updated_at,
				features: features.map((f) => ({
					id: f.id,
					slug: f.slug,
					title: f.title,
					summary: f.summary,
					state: f.state,
					branchName: f.branch_name,
					taskPath: f.task_path,
					rowVersion: f.row_version,
					archivedAt: f.archived_at,
					createdAt: f.created_at,
					updatedAt: f.updated_at,
				})),
				developmentProgress: progress,
			},
		});
	});

	return app;
}
