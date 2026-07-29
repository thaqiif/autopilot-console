/** Persisted activity stream. REST remains the source of truth after disconnects. */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";

type Timer = unknown;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EventRouteOptions {
	sql: Queryable;
	setInterval?: (callback: () => void, delayMs: number) => Timer;
	clearInterval?: (timer: Timer) => void;
}

interface EventRow extends Record<string, unknown> {
	id: string;
	project_id: string | null;
	feature_id: string | null;
	attempt_id: string | null;
	type: string;
	summary: string;
	metadata: unknown;
	occurred_at: Date;
}

export function createEventRoutes(options: EventRouteOptions): Hono {
	const app = new Hono();
	const schedule = options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
	const clear =
		options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));

	app.get("/api/events", (c) => {
		const lastEventId = c.req.header("Last-Event-ID");
		const encoder = new TextEncoder();
		let heartbeat: Timer | undefined;
		let poller: Timer | undefined;
		let closed = false;
		let polling = false;
		let cursor: { occurredAt: Date; id: string } | null = null;

		const cleanup = () => {
			if (closed) return;
			closed = true;
			if (heartbeat !== undefined) clear(heartbeat);
			if (poller !== undefined) clear(poller);
		};

		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				const initial = await readInitial(options.sql, lastEventId);
				if (closed) return;
				let initialFrames = initial.gap ? toReconciliationFrame(lastEventId) : "";
				if (initial.rows.length > 0) {
					initialFrames += initial.rows.map(toFrame).join("");
					controller.enqueue(encoder.encode(initialFrames));
					const last = initial.rows[initial.rows.length - 1];
					if (last) cursor = { occurredAt: last.occurred_at, id: last.id };
				} else if (initialFrames) {
					controller.enqueue(encoder.encode(initialFrames));
				} else {
					controller.enqueue(encoder.encode(": connected\n\n"));
				}

				heartbeat = schedule(() => {
					if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
				}, 30_000);
				poller = schedule(() => {
					if (closed || polling) return;
					polling = true;
					void readAfter(options.sql, cursor)
						.then((rows) => {
							if (closed || rows.length === 0) return;
							controller.enqueue(encoder.encode(rows.map(toFrame).join("")));
							const last = rows[rows.length - 1];
							if (last) cursor = { occurredAt: last.occurred_at, id: last.id };
						})
						.finally(() => {
							polling = false;
						});
				}, 1_000);
				c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
			},
			cancel: cleanup,
		});

		return new Response(body, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	return app;
}

interface InitialEvents {
	rows: EventRow[];
	gap: boolean;
}

async function readInitial(
	sql: Queryable,
	lastEventId: string | undefined,
): Promise<InitialEvents> {
	if (lastEventId && UUID_RE.test(lastEventId)) {
		const marker = await sql`
			SELECT id, occurred_at FROM activity_events WHERE id = ${lastEventId} LIMIT 1
		`;
		const row = marker[0];
		if (row) {
			return {
				rows: await readAfter(sql, {
					occurredAt: row.occurred_at as Date,
					id: row.id as string,
				}),
				gap: false,
			};
		}
	}
	const rows = await sql`
		SELECT * FROM (
			SELECT id, project_id, feature_id, attempt_id, type, summary, metadata, occurred_at
			FROM activity_events ORDER BY occurred_at DESC, id DESC LIMIT 50
		) recent ORDER BY occurred_at ASC, id ASC
	`;
	return {
		rows: rows as unknown as EventRow[],
		gap: lastEventId !== undefined,
	};
}

async function readAfter(
	sql: Queryable,
	cursor: { occurredAt: Date; id: string } | null,
): Promise<EventRow[]> {
	if (!cursor) {
		const rows = await sql`
			SELECT id, project_id, feature_id, attempt_id, type, summary, metadata, occurred_at
			FROM activity_events
			ORDER BY occurred_at ASC, id ASC
			LIMIT 100
		`;
		return rows as unknown as EventRow[];
	}
	const rows = await sql`
		SELECT id, project_id, feature_id, attempt_id, type, summary, metadata, occurred_at
		FROM activity_events
		WHERE (occurred_at, id) > (${cursor.occurredAt}, ${cursor.id})
		ORDER BY occurred_at ASC, id ASC LIMIT 100
	`;
	return rows as unknown as EventRow[];
}

function toReconciliationFrame(lastEventId: string | undefined): string {
	return [
		"event: reconcile",
		`data: ${JSON.stringify({
			reason: "event_gap",
			lastEventId: lastEventId ?? null,
			reload: "/api/overview",
		})}`,
		"",
		"",
	].join("\n");
}

function toFrame(row: EventRow): string {
	const data = {
		id: row.id,
		projectId: row.project_id,
		featureId: row.feature_id,
		attemptId: row.attempt_id,
		type: row.type,
		summary: row.summary,
		metadata: row.metadata,
		occurredAt: row.occurred_at.toISOString(),
	};
	return `id: ${row.id}\nevent: activity\ndata: ${JSON.stringify(data)}\n\n`;
}
