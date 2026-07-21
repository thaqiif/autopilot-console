/**
 * Project mutation routes (requirement 22).
 *
 * POST   /api/projects       — create project
 * PUT    /api/projects/:id   — update project
 * POST   /api/projects/:id/archive — archive project
 *
 * All mutations are CSRF-protected (middleware), authenticated (middleware),
 * and delegate to domain ProjectService. No worker-side adapter effects
 * execute in request scope.
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import { getWorkspace } from "../../../../packages/database/src/index";
import type { ProjectService } from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface ProjectRoutesOptions {
	projectService: ProjectService;
	sql: Queryable;
	now?: () => Date;
}

export function createProjectRoutes(options: ProjectRoutesOptions): Hono {
	const app = new Hono();
	const { projectService, sql } = options;

	app.post("/api/projects", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Request body must be JSON.",
				httpStatus: 400,
				correlationId,
			});
		}

		const name = typeof body.name === "string" ? body.name.trim() : "";
		const slug = typeof body.slug === "string" ? body.slug.trim() : "";
		const githubOwner = typeof body.githubOwner === "string" ? body.githubOwner.trim() : "";
		const githubRepo = typeof body.githubRepo === "string" ? body.githubRepo.trim() : "";
		const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath.trim() : "";
		const developmentBranch =
			typeof body.developmentBranch === "string" ? body.developmentBranch.trim() : "";
		const description = typeof body.description === "string" ? body.description : undefined;

		const workspace = await getWorkspace(sql);
		if (!workspace) {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: "No workspace configured. Run bootstrap first.",
				httpStatus: 503,
				correlationId,
			});
		}
		const workspaceId = workspace.id;

		if (!name) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Project name is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!slug) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Project slug is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!githubOwner || !githubRepo) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "GitHub owner and repo are required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!workspacePath) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Workspace path is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!developmentBranch) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Development branch is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		const result = await projectService.createProject({
			name,
			slug,
			githubOwner,
			githubRepo,
			workspacePath,
			developmentBranch,
			description,
			workspaceId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});

		if (!result.ok) {
			const code =
				result.reason === "UNIQUENESS_VIOLATION"
					? "CONFLICT"
					: result.reason === "VALIDATION_FAILED"
						? "VALIDATION_FAILED"
						: "PRECONDITION_FAILED";
			const httpStatus =
				result.reason === "UNIQUENESS_VIOLATION"
					? 409
					: result.reason === "VALIDATION_FAILED"
						? 400
						: 409;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
				details: result.validation ? { validation: result.validation } : undefined,
			});
		}

		return c.json({ ok: true as const, data: result.project }, 201);
	});

	app.put("/api/projects/:id", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const projectId = c.req.param("id");

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}

		const updateInput: Record<string, unknown> = {
			projectId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		};
		if (typeof body.name === "string") updateInput.name = body.name;
		if (typeof body.slug === "string") updateInput.slug = body.slug;
		if (typeof body.description === "string" || body.description === null)
			updateInput.description = body.description;
		if (typeof body.githubOwner === "string") updateInput.githubOwner = body.githubOwner;
		if (typeof body.githubRepo === "string") updateInput.githubRepo = body.githubRepo;
		if (typeof body.workspacePath === "string") updateInput.workspacePath = body.workspacePath;
		if (typeof body.developmentBranch === "string")
			updateInput.developmentBranch = body.developmentBranch;

		const result = await projectService.updateProject(
			updateInput as Parameters<typeof projectService.updateProject>[0],
		);

		if (!result.ok) {
			const code =
				result.reason === "NOT_FOUND"
					? "NOT_FOUND"
					: result.reason === "ALREADY_ARCHIVED"
						? "NOT_FOUND"
						: result.reason === "UNIQUENESS_VIOLATION"
							? "CONFLICT"
							: result.reason === "ACTIVE_JOBS"
								? "CONFLICT"
								: "VALIDATION_FAILED";
			const httpStatus =
				result.reason === "NOT_FOUND" || result.reason === "ALREADY_ARCHIVED"
					? 404
					: result.reason === "ACTIVE_JOBS"
						? 409
						: result.reason === "UNIQUENESS_VIOLATION"
							? 409
							: 400;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json({ ok: true as const, data: result.project }, 200);
	});

	app.post("/api/projects/:id/archive", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const projectId = c.req.param("id");

		const result = await projectService.archiveProject({
			projectId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});

		if (!result.ok) {
			const code =
				result.reason === "NOT_FOUND"
					? "NOT_FOUND"
					: result.reason === "ALREADY_ARCHIVED"
						? "CONFLICT"
						: "CONFLICT";
			const httpStatus =
				result.reason === "NOT_FOUND" ? 404 : result.reason === "ALREADY_ARCHIVED" ? 409 : 409;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json({ ok: true as const, data: result.project }, 200);
	});

	return app;
}
