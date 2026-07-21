/**
 * Health/readiness route (requirement 21).
 * Public (no session required). Aggregates dependency probes and returns a
 * redacted readiness report. No credentials or secret-bearing fields leak.
 */

import { Hono } from "hono";
import type { HealthProbe, HealthService } from "../health/health-service";

export interface HealthRoutesOptions {
	health: HealthService;
	now?: () => Date;
}

export function createHealthRoutes(options: HealthRoutesOptions): Hono {
	const app = new Hono();
	const now = options.now ?? (() => new Date());

	app.get("/api/health", async (c) => {
		const report = await options.health.readiness();
		const status = report.status === "ok" ? 200 : 503;
		return c.json(
			{ ok: true as const, data: report, correlationId: c.get("correlationId") },
			status,
		);
	});

	app.get("/api/health/live", (c) => {
		return c.json({
			ok: true as const,
			data: { status: options.health.liveness(), checkedAt: now().toISOString() },
		});
	});

	return app;
}

/** Default probes used when the real adapters are not yet wired (req 21 boundary). */
export function defaultHealthProbes(): {
	database: HealthProbe;
	worker: HealthProbe;
	autopilot: HealthProbe;
	github: HealthProbe;
} {
	const ok = (name: string): HealthProbe => ({
		name,
		check: async () => ({ ok: true, detail: { available: true } }),
	});
	return {
		database: ok("database"),
		worker: ok("worker"),
		autopilot: ok("autopilot"),
		github: ok("github"),
	};
}
