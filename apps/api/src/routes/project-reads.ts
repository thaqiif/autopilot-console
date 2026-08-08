/**
 * Project read routes (requirement 23).
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface ProjectReadRouteOptions {
	sql: Queryable;
}

export function createProjectReadRoutes(options: ProjectReadRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/projects", async (c) => {
		const projects = await options.sql`
			SELECT id, workspace_id, name, slug, description, github_owner, github_repo,
				canonical_path, development_branch, validation_status, last_validated_at,
				status, archived_at, created_at, updated_at
			FROM projects
			WHERE status = 'active' AND archived_at IS NULL
			ORDER BY created_at DESC
		`;

		return c.json({
			ok: true as const,
			data: projects.map((p) => ({
				id: p.id,
				name: p.name,
				slug: p.slug,
				description: p.description,
				githubOwner: p.github_owner,
				githubRepo: p.github_repo,
				canonicalPath: p.canonical_path,
				developmentBranch: p.development_branch,
				status: p.status,
				createdAt: p.created_at,
				updatedAt: p.updated_at,
			})),
		});
	});

	app.get("/api/projects/:id", async (c) => {
		const { id } = c.req.param();

		const [project] = await options.sql`
			SELECT id, workspace_id, name, slug, description, github_owner, github_repo,
				canonical_path, development_branch, validation_status, last_validated_at,
				status, archived_at, created_at, updated_at
			FROM projects
			WHERE id = ${id}
		`;

		if (!project) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Project not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		// Get releases
		const releases = await options.sql`
			SELECT id, name, version, description, sort_order, status, archived_at, created_at, updated_at
			FROM releases
			WHERE project_id = ${id}
			ORDER BY sort_order ASC
		`;

		return c.json({
			ok: true as const,
			data: {
				id: project.id,
				name: project.name,
				slug: project.slug,
				description: project.description,
				githubOwner: project.github_owner,
				githubRepo: project.github_repo,
				canonicalPath: project.canonical_path,
				developmentBranch: project.development_branch,
				validationStatus: project.validation_status,
				lastValidatedAt: project.last_validated_at,
				status: project.status,
				archivedAt: project.archived_at,
				createdAt: project.created_at,
				updatedAt: project.updated_at,
				releases: releases.map((r) => ({
					id: r.id,
					name: r.name,
					version: r.version,
					description: r.description,
					sortOrder: r.sort_order,
					status: r.status,
					archivedAt: r.archived_at,
					createdAt: r.created_at,
					updatedAt: r.updated_at,
				})),
			},
		});
	});

	app.get("/api/projects/:id/releases", async (c) => {
		const { id } = c.req.param();

		const [project] = await options.sql`
			SELECT id FROM projects WHERE id = ${id}
		`;

		if (!project) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Project not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		const releases = await options.sql`
			SELECT id, project_id, name, version, description, sort_order, status, archived_at, created_at, updated_at
			FROM releases
			WHERE project_id = ${id}
			ORDER BY sort_order ASC
		`;

		return c.json({
			ok: true as const,
			data: releases.map((r) => ({
				id: r.id,
				projectId: r.project_id,
				name: r.name,
				version: r.version,
				description: r.description,
				sortOrder: r.sort_order,
				status: r.status,
				archivedAt: r.archived_at,
				createdAt: r.created_at,
				updatedAt: r.updated_at,
			})),
		});
	});

	return app;
}
