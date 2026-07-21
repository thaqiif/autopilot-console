/**
 * Overview route for the portfolio dashboard (requirement 23).
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import { queryOverview } from "../queries/overview-query";

export interface OverviewRouteOptions {
	sql: Queryable;
}

export function createOverviewRoutes(options: OverviewRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/overview", async (c) => {
		const metrics = await queryOverview(options.sql);
		return c.json({ ok: true as const, data: metrics });
	});

	return app;
}
