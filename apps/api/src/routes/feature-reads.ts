/**
 * Feature read routes (requirement 23).
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import { createNormalizedError } from "../../../../packages/shared/src/index";
import { queryFeatureDetail } from "../queries/feature-detail-query";

export interface FeatureReadRouteOptions {
	sql: Queryable;
}

export function createFeatureReadRoutes(options: FeatureReadRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/features/:id", async (c) => {
		const { id } = c.req.param();

		const detail = await queryFeatureDetail(options.sql, id);

		if (!detail) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		return c.json({ ok: true as const, data: detail });
	});

	return app;
}
