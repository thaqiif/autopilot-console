import { describe, expect, test } from "bun:test";
import { createHealthService, type HealthProbe } from "./health-service";

const ok = (name: string): HealthProbe => ({ name, check: async () => ({ ok: true }) });

describe("readiness aggregation", () => {
	test("reports a rejected database probe as down without leaking its error", async () => {
		const service = createHealthService({
			now: () => new Date("2026-07-19T00:00:00.000Z"),
			database: {
				name: "database",
				check: async () => {
					throw new Error("postgres://owner:secret@database/private");
				},
			},
			worker: ok("worker"),
			autopilot: ok("autopilot"),
			github: ok("github"),
		});

		const report = await service.readiness();
		expect(report.status).toBe("down");
		expect(report.database.status).toBe("down");
		expect(JSON.stringify(report)).not.toContain("secret");
		expect(JSON.stringify(report)).not.toContain("postgres://");
	});

	test("reports optional dependency failure as degraded while database is ready", async () => {
		const service = createHealthService({
			now: () => new Date("2026-07-19T00:00:00.000Z"),
			database: ok("database"),
			worker: { name: "worker", check: async () => ({ ok: false }) },
			autopilot: ok("autopilot"),
			github: ok("github"),
		});

		const report = await service.readiness();
		expect(report.status).toBe("degraded");
		expect(report.worker.status).toBe("down");
	});
});
