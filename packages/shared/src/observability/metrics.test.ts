import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDiagnosticLogRetention } from "./diagnostic-retention";
import { createMetricsCollector } from "./metrics";
import {
	applyRuntimeMetricEvent,
	PRODUCTION_DIAGNOSTIC_LIMITS,
	type RuntimeMetricEvent,
} from "./runtime-metrics";
import { createStructuredLogger, type StructuredLogEntry } from "./structured-logger";

describe("metrics collector", () => {
	test("tracks queue depth active jobs oldest age and heartbeat age", () => {
		const metrics = createMetricsCollector({
			now: () => new Date("2026-07-31T12:00:00.000Z"),
		});
		metrics.setQueueDepth(7, 42_000);
		metrics.setActiveJobs(2, 4);
		metrics.setHeartbeatAge(1_500);

		const snap = metrics.snapshot();
		expect(snap.collectedAt).toBe("2026-07-31T12:00:00.000Z");
		expect(snap.queue).toEqual({ depth: 7, oldestAge: 42_000 });
		expect(snap.worker).toEqual({ activeJobs: 2, maxConcurrentJobs: 4, heartbeatAge: 1_500 });
	});

	test("tracks durations interruptions adapter errors polling lag and attention counts", () => {
		const metrics = createMetricsCollector();
		metrics.recordJobStart();
		metrics.recordJobDuration(1_200);
		metrics.recordJobInterrupt();
		metrics.incrementAdapterError("github");
		metrics.incrementAdapterError("git");
		metrics.setPollingLag(900);
		metrics.setAttentionCounts(5, 2);
		metrics.recordJobComplete();
		metrics.recordJobFail();
		metrics.recordJobCancel();

		const snap = metrics.snapshot();
		expect(snap.jobs).toMatchObject({
			totalStarted: 1,
			totalCompleted: 1,
			totalFailed: 1,
			totalCancelled: 1,
			totalInterrupted: 1,
			averageDuration: 1_200,
		});
		expect(snap.adapters).toEqual({ githubErrors: 1, gitErrors: 1, pollingLag: 900 });
		expect(snap.attention).toEqual({ pendingCount: 5, urgentCount: 2 });
	});
});

describe("production observability composition", () => {
	test("runtime events from real operations update every required metric field", () => {
		const metrics = createMetricsCollector({
			now: () => new Date("2026-07-31T15:00:00.000Z"),
		});

		const events: RuntimeMetricEvent[] = [
			{ type: "queue", depth: 3, oldestAgeMs: 12_000 },
			{ type: "active_jobs", count: 2, maxConcurrent: 4 },
			{ type: "heartbeat_age", ageMs: 250 },
			{ type: "job_start" },
			{ type: "job_complete", durationMs: 4_000 },
			{ type: "job_start" },
			{ type: "job_fail", durationMs: 1_500 },
			{ type: "job_start" },
			{ type: "job_interrupt", durationMs: 800 },
			{ type: "job_start" },
			{ type: "job_cancel", durationMs: 300 },
			{ type: "adapter_error", kind: "git" },
			{ type: "adapter_error", kind: "github" },
			{ type: "adapter_error", kind: "github" },
			{ type: "polling_lag", lagMs: 45_000 },
			{ type: "attention", pending: 7, urgent: 2 },
		];
		for (const event of events) applyRuntimeMetricEvent(metrics, event);

		const snap = metrics.snapshot();
		expect(snap.queue).toEqual({ depth: 3, oldestAge: 12_000 });
		expect(snap.worker).toEqual({
			activeJobs: 2,
			maxConcurrentJobs: 4,
			heartbeatAge: 250,
		});
		expect(snap.jobs.totalStarted).toBe(4);
		expect(snap.jobs.totalCompleted).toBe(1);
		expect(snap.jobs.totalFailed).toBe(1);
		expect(snap.jobs.totalInterrupted).toBe(1);
		expect(snap.jobs.totalCancelled).toBe(1);
		expect(snap.jobs.averageDuration).toBe((4_000 + 1_500 + 800 + 300) / 4);
		expect(snap.adapters).toEqual({
			githubErrors: 2,
			gitErrors: 1,
			pollingLag: 45_000,
		});
		expect(snap.attention).toEqual({ pendingCount: 7, urgentCount: 2 });
	});

	test("structured logs include correlation project feature attempt adapter and worker context after redaction", () => {
		const entries: StructuredLogEntry[] = [];
		const logger = createStructuredLogger({
			level: "debug",
			now: () => new Date("2026-07-31T15:00:00.000Z"),
			write: (entry) => entries.push(entry),
			baseContext: {
				service: "worker",
				workerId: "worker-host-1",
			},
		});

		logger.info("handoff failed", {
			correlationId: "corr_parent/job:abc",
			projectId: "proj_1",
			featureId: "feat_1",
			jobAttemptId: "attempt_1",
			adapter: "github",
			authorization: "Bearer super-secret-token",
		});

		expect(entries).toHaveLength(1);
		const context = entries[0]?.context;
		expect(context).toMatchObject({
			service: "worker",
			workerId: "worker-host-1",
			correlationId: "corr_parent/job:abc",
			projectId: "proj_1",
			featureId: "feat_1",
			jobAttemptId: "attempt_1",
			adapter: "github",
		});
		const serialized = JSON.stringify(entries[0]);
		expect(serialized).not.toContain("super-secret-token");
		expect(serialized).toContain("[REDACTED]");
	});

	test("diagnostic retention enforces per-attempt and total limits with explicit truncation", async () => {
		const files = new Map<string, string>();
		const retention = createDiagnosticLogRetention({
			rootDir: "/app/logs",
			maxFileBytes: 80,
			maxPerAttemptBytes: 160,
			maxTotalBytes: 220,
			now: () => new Date("2026-07-31T15:00:00.000Z"),
			fs: {
				mkdir: async () => undefined,
				readdir: async () => [...files.keys()].map((path) => path.split("/").pop() ?? path),
				stat: async (path) => {
					const body = files.get(path) ?? "";
					return {
						size: Buffer.byteLength(body, "utf8"),
						mtimeMs: Date.parse("2026-07-31T15:00:00.000Z"),
					};
				},
				unlink: async (path) => {
					files.delete(path);
				},
				writeFile: async (path, body) => {
					files.set(path, body);
				},
			},
		});

		// First write for attempt A is stored with redacted secrets and truncation marker.
		await retention.write({
			stream: "stdout",
			body: `token=ghp_abcdefghijklmnopqrstuvwxyz ${"progress-line\n".repeat(40)}`,
			projectId: "proj_1",
			featureId: "feat_1",
			jobAttemptId: "attempt_a",
			correlationId: "corr_a",
		});
		// Second write exceeds per-attempt budget — still written as an explicit truncation record
		// that preserves structured metadata for progress/audit correlation.
		await retention.write({
			stream: "stderr",
			body: `more output ${"y".repeat(400)}`,
			projectId: "proj_1",
			featureId: "feat_1",
			jobAttemptId: "attempt_a",
			correlationId: "corr_a",
		});
		// Another attempt should still be accepted until total budget is hit.
		await retention.write({
			stream: "stdout",
			body: "attempt b body",
			jobAttemptId: "attempt_b",
			correlationId: "corr_b",
		});

		const payloads = [...files.values()];
		expect(payloads.length).toBeGreaterThanOrEqual(2);
		for (const payload of payloads) {
			expect(payload).not.toContain("ghp_");
			const parsed = JSON.parse(payload.trim()) as {
				projectId?: string;
				featureId?: string;
				jobAttemptId?: string;
				correlationId?: string;
				body: string;
				truncated: boolean;
			};
			// Structured progress/audit correlation fields survive truncation.
			expect(parsed.jobAttemptId).toBeTruthy();
			expect(parsed.correlationId).toBeTruthy();
			if (parsed.jobAttemptId === "attempt_a") {
				expect(parsed.projectId).toBe("proj_1");
				expect(parsed.featureId).toBe("feat_1");
				expect(parsed.truncated === true || parsed.body.includes("…[TRUNCATED]")).toBe(true);
			}
		}

		const beforePrune = files.size;
		const pruned = await retention.prune();
		expect(beforePrune).toBeGreaterThan(0);
		expect(pruned.remainingBytes).toBeLessThanOrEqual(220);

		expect(PRODUCTION_DIAGNOSTIC_LIMITS.maxFileBytes).toBe(64 * 1024);
		expect(PRODUCTION_DIAGNOSTIC_LIMITS.maxPerAttemptBytes).toBe(512 * 1024);
		expect(PRODUCTION_DIAGNOSTIC_LIMITS.maxTotalBytes).toBe(32 * 1024 * 1024);
	});

	test("deployment and operations docs cover every required operator procedure", () => {
		const repoRoot = join(import.meta.dir, "../../../../");
		const deployment = readFileSync(join(repoRoot, "docs/deployment.md"), "utf8");
		const operations = readFileSync(join(repoRoot, "docs/operations.md"), "utf8");

		// Deployment: prerequisites, Bun/autopilotagent, mounts, secrets, migrations,
		// trusted TLS proxy, Secure cookies, startup, health.
		for (const pattern of [
			/prerequisites/i,
			/\bBun\b/i,
			/autopilotagent/i,
			/mount/i,
			/secret/i,
			/migrat/i,
			/TLS|reverse proxy/i,
			/Secure/i,
			/cookie/i,
			/startup|docker compose up/i,
			/health/i,
			/diagnostic/i,
			/retention|maxPerAttempt|maxTotal|64\s*\*\s*1024|512\s*KiB|32\s*MiB/i,
		]) {
			expect(deployment).toMatch(pattern);
		}

		// Operations: backup, restore, cancellation/escalation, interruption, retry,
		// GitHub reconciliation, diagnostics, retention, safe upgrades.
		for (const pattern of [
			/backup/i,
			/restore|recover/i,
			/cancel/i,
			/escalat|SIGUSR1|SIGTERM|SIGKILL/i,
			/interrupt/i,
			/retry/i,
			/reconcil/i,
			/GitHub/i,
			/diagnostic/i,
			/retention/i,
			/upgrade/i,
			/queue depth|active jobs|polling lag|attention/i,
		]) {
			expect(operations).toMatch(pattern);
		}

		// Docs must not claim production wiring that is unfinished once composition is complete.
		expect(deployment).not.toMatch(
			/Complete adapter\/error and\s+attention context propagation remain open/i,
		);
		expect(deployment).not.toMatch(
			/PR handoff and GitHub reconciliation components exist but are not composed/i,
		);
	});

	test("worker and API entrypoints emit metrics from real operations paths", () => {
		const repoRoot = join(import.meta.dir, "../../../../");
		const workerMain = readFileSync(join(repoRoot, "apps/worker/src/main.ts"), "utf8");
		const apiMain = readFileSync(join(repoRoot, "apps/api/src/main.ts"), "utf8");
		const githubRuntime = readFileSync(
			join(repoRoot, "apps/worker/src/runtime/github-runtime.ts"),
			"utf8",
		);
		const jobCommands = readFileSync(
			join(repoRoot, "apps/worker/src/runtime/job-command-worker.ts"),
			"utf8",
		);

		expect(workerMain).toMatch(/applyRuntimeMetricEvent|recordJobStart|setAttentionCounts/);
		expect(workerMain).toMatch(/type:\s*["']attention["']|setAttentionCounts/);
		expect(workerMain).toMatch(
			/adapter:\s*["']worker["']|adapter:\s*["']git["']|adapter:\s*["']github["']/,
		);
		expect(workerMain).toMatch(/createDiagnosticLogRetention/);
		expect(workerMain).toMatch(/maxPerAttemptBytes|PRODUCTION_DIAGNOSTIC_LIMITS/);
		expect(apiMain).toMatch(/createMetricsCollector/);
		expect(apiMain).toMatch(/incrementAdapterError\("github"\)/);
		expect(githubRuntime).toMatch(/polling_lag|onMetric/);
		expect(githubRuntime).toMatch(/adapter_error|adapter/);
		expect(jobCommands).toMatch(/job_cancel|onMetric/);
	});
});
