/**
 * Health/readiness aggregation.
 * Each probe reports ok + a redacted detail; no credential or secret-bearing
 * field is ever included. Dependencies are injected so tests run with fakes.
 */

import { redactValue } from "../../../../packages/shared/src/index";

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthProbe {
	name: string;
	check: () => Promise<{ ok: boolean; detail?: Record<string, unknown> }>;
}

export interface HealthComponentState {
	name: string;
	status: HealthStatus;
	detail?: Record<string, unknown>;
}

export interface HealthReport {
	status: HealthStatus;
	database: HealthComponentState;
	worker: HealthComponentState;
	autopilot: HealthComponentState;
	github: HealthComponentState;
	checkedAt: string;
}

export interface HealthServiceOptions {
	now: () => Date;
	database: HealthProbe;
	worker: HealthProbe;
	autopilot: HealthProbe;
	github: HealthProbe;
}

export interface HealthService {
	readiness(): Promise<HealthReport>;
	liveness(): HealthStatus;
}

function component(
	name: string,
	result: { ok: boolean; detail?: Record<string, unknown> },
): HealthComponentState {
	const safeDetail = result.detail
		? (redactValue(result.detail) as Record<string, unknown>)
		: undefined;
	return {
		name,
		status: result.ok ? "ok" : "down",
		detail: safeDetail,
	};
}

function rollup(components: HealthComponentState[]): HealthStatus {
	if (components.every((c) => c.status === "ok")) return "ok";
	if (components[0]?.status === "down") return "down";
	return "degraded";
}

async function runProbe(
	probe: HealthProbe,
): Promise<{ ok: boolean; detail?: Record<string, unknown> }> {
	try {
		return await probe.check();
	} catch {
		return { ok: false };
	}
}

export function createHealthService(options: HealthServiceOptions): HealthService {
	return {
		liveness() {
			return "ok";
		},
		async readiness() {
			const [database, worker, autopilot, github] = await Promise.all([
				runProbe(options.database),
				runProbe(options.worker),
				runProbe(options.autopilot),
				runProbe(options.github),
			]);
			const databaseState = component("database", database);
			const workerState = component("worker", worker);
			const autopilotState = component("autopilot", autopilot);
			const githubState = component("github", github);
			const components = [databaseState, workerState, autopilotState, githubState];
			return {
				status: rollup(components),
				database: databaseState,
				worker: workerState,
				autopilot: autopilotState,
				github: githubState,
				checkedAt: options.now().toISOString(),
			};
		},
	};
}
