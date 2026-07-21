import { describe, expect, test } from "bun:test";
import type { Queryable } from "../../../../packages/database/src/index";
import { createEventRoutes } from "./events";

describe("persisted event stream", () => {
	test("replays persisted activity after Last-Event-ID and clears timers on cancel", async () => {
		let query = 0;
		const sql = (async () => {
			query += 1;
			if (query === 1) {
				return [{ id: "event-b", occurred_at: new Date("2026-07-19T00:00:00.000Z") }];
			}
			if (query === 2) {
				return [
					{
						id: "event-c",
						type: "feature.updated",
						summary: "Feature updated",
						project_id: "project-1",
						feature_id: "feature-1",
						attempt_id: null,
						metadata: null,
						occurred_at: new Date("2026-07-19T00:00:01.000Z"),
					},
				];
			}
			return [];
		}) as unknown as Queryable;
		let timerId = 0;
		const cleared: number[] = [];
		const app = createEventRoutes({
			sql,
			setInterval: () => ++timerId,
			clearInterval: (id) => cleared.push(id as number),
		});

		const response = await app.request("/api/events", {
			headers: { "Last-Event-ID": "event-b" },
		});
		const reader = response.body?.getReader();
		const chunk = await reader?.read();
		const text = new TextDecoder().decode(chunk?.value);
		expect(text).toContain("id: event-c");
		expect(text).toContain('"summary":"Feature updated"');
		await reader?.cancel();
		expect(cleared.sort()).toEqual([1, 2]);
	});
});
