/**
 * Release mutation routes (requirement 22).
 *
 * POST   /api/releases              — create release
 * PUT    /api/releases/:id          — update release
 * POST   /api/releases/:id/archive  — archive release
 */

import { Hono } from "hono";
import type { ReleaseService } from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface ReleaseRoutesOptions {
	releaseService: ReleaseService;
}

export function createReleaseRoutes(options: ReleaseRoutesOptions): Hono {
	const app = new Hono();
	const { releaseService } = options;

	app.post("/api/releases", async (c) => {
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

		const projectId = typeof body.projectId === "string" ? body.projectId : "";
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const version = typeof body.version === "string" ? body.version.trim() : "";
		const description = typeof body.description === "string" ? body.description : undefined;

		if (!projectId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Project ID is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!name) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Release name is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!version) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Release version is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		const result = await releaseService.createRelease({
			projectId,
			name,
			version,
			description,
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
					: result.reason === "UNIQUENESS_VIOLATION"
						? "CONFLICT"
						: "VALIDATION_FAILED";
			const httpStatus =
				result.reason === "NOT_FOUND" ? 404 : result.reason === "UNIQUENESS_VIOLATION" ? 409 : 400;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json({ ok: true as const, data: result.release }, 201);
	});

	app.put("/api/releases/:id", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const releaseId = c.req.param("id");

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}

		const updateInput: Record<string, unknown> = {
			releaseId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		};
		if (typeof body.name === "string") updateInput.name = body.name;
		if (typeof body.version === "string") updateInput.version = body.version;
		if (typeof body.description === "string" || body.description === null)
			updateInput.description = body.description;

		const result = await releaseService.updateRelease(
			updateInput as Parameters<typeof releaseService.updateRelease>[0],
		);

		if (!result.ok) {
			const httpStatus =
				result.reason === "NOT_FOUND" || result.reason === "ALREADY_ARCHIVED"
					? 404
					: result.reason === "UNIQUENESS_VIOLATION"
						? 409
						: 400;
			const code =
				result.reason === "NOT_FOUND"
					? "NOT_FOUND"
					: result.reason === "ALREADY_ARCHIVED"
						? "NOT_FOUND"
						: result.reason === "UNIQUENESS_VIOLATION"
							? "CONFLICT"
							: "VALIDATION_FAILED";
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json({ ok: true as const, data: result.release }, 200);
	});

	app.post("/api/releases/:id/archive", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const releaseId = c.req.param("id");

		const result = await releaseService.archiveRelease({
			releaseId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});

		if (!result.ok) {
			const httpStatus =
				result.reason === "NOT_FOUND" ? 404 : result.reason === "ALREADY_ARCHIVED" ? 409 : 409;
			const code = result.reason === "NOT_FOUND" ? "NOT_FOUND" : "CONFLICT";
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json({ ok: true as const, data: result.release }, 200);
	});

	return app;
}
