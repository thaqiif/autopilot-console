import { describe, expect, test } from "bun:test";
import type { Queryable } from "../../../../packages/database/src/index";
import { createEventRoutes } from "./events";

describe("persisted event stream", () => {
	test("replays persisted activity after Last-Event-ID and clears timers on cancel", async () => {
		const markerId = "00000000-0000-4000-8000-000000000001";
		const nextId = "00000000-0000-4000-8000-000000000002";
		let query = 0;
		const sql = (async () => {
			query += 1;
			if (query === 1) {
				return [{ id: markerId, occurred_at: new Date("2026-07-19T00:00:00.000Z") }];
			}
			if (query === 2) {
				return [
					{
						id: nextId,
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
			headers: { "Last-Event-ID": markerId },
		});
		const reader = response.body?.getReader();
		const chunk = await reader?.read();
		const text = new TextDecoder().decode(chunk?.value);
		expect(text).toContain(`id: ${nextId}`);
		expect(text).toContain('"summary":"Feature updated"');
		await reader?.cancel();
		expect(cleared.sort()).toEqual([1, 2]);
	});

	test("signals REST reconciliation when a persisted Last-Event-ID cannot be found", async () => {
		let query = 0;
		const sql = (async () => {
			query += 1;
			if (query === 1) return [];
			if (query === 2) {
				return [
					{
						id: "event-current",
						type: "feature.updated",
						summary: "Feature updated",
						project_id: "project-1",
						feature_id: "feature-1",
						attempt_id: null,
						metadata: null,
						occurred_at: new Date("2026-07-29T20:00:00.000Z"),
					},
				];
			}
			return [];
		}) as unknown as Queryable;
		const app = createEventRoutes({
			sql,
			setInterval: () => 1,
			clearInterval: () => {},
		});

		const response = await app.request("/api/events", {
			headers: { "Last-Event-ID": "00000000-0000-4000-8000-000000000099" },
		});
		const reader = response.body?.getReader();
		const chunk = await reader?.read();
		const text = new TextDecoder().decode(chunk?.value);
		await reader?.cancel();

		expect(text).toContain("event: reconcile");
		expect(text).toContain('"reason":"event_gap"');
		expect(text).toContain('"reload":"/api/overview"');
		expect(text).toContain("id: event-current");
	});
});
