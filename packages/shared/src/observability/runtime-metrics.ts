/**
 * Maps production runtime domain events onto the shared MetricsCollector.
 * API and worker entrypoints emit these events from real operations so the
 * in-memory snapshot always reflects queue, job lifecycle, adapters, and attention.
 */

import type { MetricsCollector } from "./metrics";

export type RuntimeMetricEvent =
	| { type: "queue"; depth: number; oldestAgeMs: number }
	| { type: "active_jobs"; count: number; maxConcurrent: number }
	| { type: "heartbeat_age"; ageMs: number }
	| { type: "job_start" }
	| { type: "job_complete"; durationMs: number }
	| { type: "job_fail"; durationMs: number }
	| { type: "job_cancel"; durationMs?: number }
	| { type: "job_interrupt"; durationMs?: number }
	| { type: "adapter_error"; kind: "git" | "github" }
	| { type: "polling_lag"; lagMs: number }
	| { type: "attention"; pending: number; urgent: number };

/**
 * Apply one runtime event to the collector. Pure side-effect on metrics only.
 */
export function applyRuntimeMetricEvent(
	metrics: MetricsCollector,
	event: RuntimeMetricEvent,
): void {
	switch (event.type) {
		case "queue":
			metrics.setQueueDepth(event.depth, event.oldestAgeMs);
			return;
		case "active_jobs":
			metrics.setActiveJobs(event.count, event.maxConcurrent);
			return;
		case "heartbeat_age":
			metrics.setHeartbeatAge(event.ageMs);
			return;
		case "job_start":
			metrics.recordJobStart();
			return;
		case "job_complete":
			metrics.recordJobDuration(event.durationMs);
			metrics.recordJobComplete();
			return;
		case "job_fail":
			metrics.recordJobDuration(event.durationMs);
			metrics.recordJobFail();
			return;
		case "job_cancel":
			if (event.durationMs !== undefined) metrics.recordJobDuration(event.durationMs);
			metrics.recordJobCancel();
			return;
		case "job_interrupt":
			if (event.durationMs !== undefined) metrics.recordJobDuration(event.durationMs);
			metrics.recordJobInterrupt();
			return;
		case "adapter_error":
			metrics.incrementAdapterError(event.kind);
			return;
		case "polling_lag":
			metrics.setPollingLag(event.lagMs);
			return;
		case "attention":
			metrics.setAttentionCounts(event.pending, event.urgent);
			return;
		default: {
			const _exhaustive: never = event;
			void _exhaustive;
		}
	}
}

/**
 * Documented diagnostic retention defaults used by production workers and ops docs.
 * Tests and operators rely on these exact numbers remaining stable.
 */
export const PRODUCTION_DIAGNOSTIC_LIMITS = {
	/** Soft cap for a single diagnostic file body (bytes, UTF-8). */
	maxFileBytes: 64 * 1024,
	/** Hard cap for cumulative diagnostic bytes for one attempt. */
	maxPerAttemptBytes: 512 * 1024,
	/** Hard cap for total diagnostic volume under the retention root. */
	maxTotalBytes: 32 * 1024 * 1024,
	/** Age after which diagnostic files are pruned (7 days). */
	maxAgeMs: 7 * 24 * 60 * 60 * 1000,
} as const;
