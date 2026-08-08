/**
 * Activity routes for global and project-scoped activity (requirement 23).
 *
 * Supports cursor pagination with newest-first ordering.
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import { createNormalizedError } from "../../../../packages/shared/src/index";

export interface ActivityRouteOptions {
	sql: Queryable;
}

interface ActivityCursor {
	occurredAt: string;
	id: string;
}

function parseLimit(raw: string | undefined): number {
	if (raw === undefined) return 50;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 50;
}

function encodeCursor(cursor: ActivityCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): ActivityCursor | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ActivityCursor;
		if (!parsed.id || !parsed.occurredAt || Number.isNaN(Date.parse(parsed.occurredAt)))
			return null;
		return parsed;
	} catch {
		return null;
	}
}

export function createActivityRoutes(options: ActivityRouteOptions): Hono {
	const app = new Hono();

	// Global activity
	app.get("/api/activity", async (c) => {
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = decodeCursor(rawCursor);
		if (rawCursor && !cursor) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Invalid activity cursor.",
				httpStatus: 400,
				correlationId: c.get("correlationId") ?? "",
			});
		}
		const queryLimit = limit + 1;

		const rows = cursor
			? await options.sql`
				SELECT id, project_id, feature_id, attempt_id, type, summary, source, metadata, occurred_at, created_at
				FROM activity_events
				WHERE (occurred_at, id) < (${new Date(cursor.occurredAt)}, ${cursor.id})
				ORDER BY occurred_at DESC, id DESC
				LIMIT ${queryLimit}
			`
			: await options.sql`
				SELECT id, project_id, feature_id, attempt_id, type, summary, source, metadata, occurred_at, created_at
				FROM activity_events
				ORDER BY occurred_at DESC, id DESC
				LIMIT ${queryLimit}
			`;

		const pageRows = rows.slice(0, limit);
		const items = pageRows.map(mapActivityRow);
		const last = pageRows[pageRows.length - 1];
		const nextCursor =
			rows.length > limit && last
				? encodeCursor({
						occurredAt: (last.occurred_at as Date).toISOString(),
						id: last.id as string,
					})
				: null;

		return c.json({ ok: true as const, data: { items, nextCursor } });
	});

	// Project-scoped activity
	app.get("/api/projects/:projectId/activity", async (c) => {
		const { projectId } = c.req.param();
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = decodeCursor(rawCursor);
		if (rawCursor && !cursor) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Invalid activity cursor.",
				httpStatus: 400,
				correlationId: c.get("correlationId") ?? "",
			});
		}
		const queryLimit = limit + 1;

		const rows = cursor
			? await options.sql`
				SELECT id, project_id, feature_id, attempt_id, type, summary, source, metadata, occurred_at, created_at
				FROM activity_events
				WHERE project_id = ${projectId}
					AND (occurred_at, id) < (${new Date(cursor.occurredAt)}, ${cursor.id})
				ORDER BY occurred_at DESC, id DESC
				LIMIT ${queryLimit}
			`
			: await options.sql`
				SELECT id, project_id, feature_id, attempt_id, type, summary, source, metadata, occurred_at, created_at
				FROM activity_events
				WHERE project_id = ${projectId}
				ORDER BY occurred_at DESC, id DESC
				LIMIT ${queryLimit}
			`;

		const pageRows = rows.slice(0, limit);
		const items = pageRows.map(mapActivityRow);
		const last = pageRows[pageRows.length - 1];
		const nextCursor =
			rows.length > limit && last
				? encodeCursor({
						occurredAt: (last.occurred_at as Date).toISOString(),
						id: last.id as string,
					})
				: null;

		return c.json({ ok: true as const, data: { items, nextCursor } });
	});

	return app;
}

function mapActivityRow(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		projectId: (row.project_id as string) ?? null,
		featureId: (row.feature_id as string) ?? null,
		attemptId: (row.attempt_id as string) ?? null,
		type: row.type as string,
		summary: row.summary as string,
		source: row.source as string,
		metadata: row.metadata ?? null,
		occurredAt: (row.occurred_at as Date).toISOString(),
		createdAt: (row.created_at as Date).toISOString(),
	};
}
