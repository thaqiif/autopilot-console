/**
 * Feature mutation routes (requirement 22).
 *
 * POST   /api/features     — create feature
 * PUT    /api/features/:id — update feature
 */

import { Hono } from "hono";
import type { FeatureService } from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface FeatureRoutesOptions {
	featureService: FeatureService;
}

export function createFeatureRoutes(options: FeatureRoutesOptions): Hono {
	const app = new Hono();
	const { featureService } = options;

	app.post("/api/features", async (c) => {
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
		const releaseId = typeof body.releaseId === "string" ? body.releaseId : "";
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const slug = typeof body.slug === "string" ? body.slug.trim() : "";
		const summary = typeof body.summary === "string" ? body.summary : undefined;

		if (!projectId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Project ID is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!releaseId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Release ID is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!title) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Feature title is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!slug) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Feature slug is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		const result = await featureService.createFeature({
			projectId,
			releaseId,
			title,
			slug,
			summary,
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
					: result.reason === "CROSS_PROJECT"
						? "NOT_FOUND"
						: result.reason === "UNIQUENESS_VIOLATION"
							? "CONFLICT"
							: "VALIDATION_FAILED";
			const httpStatus =
				result.reason === "NOT_FOUND" || result.reason === "CROSS_PROJECT"
					? 404
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

		return c.json({ ok: true as const, data: result.feature }, 201);
	});

	app.put("/api/features/:id", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const featureId = c.req.param("id");

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}

		const updateInput: Record<string, unknown> = {
			featureId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		};
		if (typeof body.title === "string") updateInput.title = body.title;
		if (typeof body.slug === "string") updateInput.slug = body.slug;
		if (typeof body.summary === "string" || body.summary === null)
			updateInput.summary = body.summary;

		const result = await featureService.updateFeature(
			updateInput as Parameters<typeof featureService.updateFeature>[0],
		);

		if (!result.ok) {
			const httpStatus =
				result.reason === "NOT_FOUND" || result.reason === "ALREADY_ARCHIVED"
					? 404
					: result.reason === "UNIQUENESS_VIOLATION"
						? 409
						: 400;
			const code =
				result.reason === "NOT_FOUND" || result.reason === "ALREADY_ARCHIVED"
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

		return c.json({ ok: true as const, data: result.feature }, 200);
	});

	return app;
}
