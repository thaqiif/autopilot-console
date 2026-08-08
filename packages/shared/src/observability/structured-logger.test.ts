import { describe, expect, test } from "bun:test";
import { createStructuredLogger, type StructuredLogEntry } from "./structured-logger";

describe("structured logger", () => {
	test("emits JSON entries with correlation project feature and job context", () => {
		const entries: StructuredLogEntry[] = [];
		const logger = createStructuredLogger({
			level: "debug",
			now: () => new Date("2026-07-31T12:00:00.000Z"),
			write: (entry) => entries.push(entry),
			baseContext: {
				correlationId: "corr_parent",
				projectId: "proj_1",
			},
		});

		logger.info("job heartbeat", {
			featureId: "feat_1",
			jobAttemptId: "attempt_1",
			queueDepth: 2,
		});

		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			timestamp: "2026-07-31T12:00:00.000Z",
			level: "info",
			message: "job heartbeat",
			context: {
				correlationId: "corr_parent",
				projectId: "proj_1",
				featureId: "feat_1",
				jobAttemptId: "attempt_1",
				queueDepth: 2,
			},
		});
	});

	test("redacts secrets before writing", () => {
		const entries: StructuredLogEntry[] = [];
		const logger = createStructuredLogger({
			write: (entry) => entries.push(entry),
		});

		logger.error("adapter failed", {
			token: "ghp_abcdefghijklmnopqrstuvwxyz",
			password: "super-secret",
			detail: "Bearer abc.def.ghi",
		});

		const serialized = JSON.stringify(entries[0]);
		expect(serialized).not.toContain("ghp_");
		expect(serialized).not.toContain("super-secret");
		expect(serialized).not.toContain("Bearer abc.def.ghi");
		expect(serialized).toContain("[REDACTED]");
	});

	test("child loggers inherit and extend context", () => {
		const entries: StructuredLogEntry[] = [];
		const root = createStructuredLogger({
			write: (entry) => entries.push(entry),
			baseContext: { correlationId: "corr_root" },
		});
		const child = root.child({ projectId: "proj_9", featureId: "feat_9" });
		child.warn("scoped event", { jobAttemptId: "job_9" });

		expect(entries[0]?.context).toMatchObject({
			correlationId: "corr_root",
			projectId: "proj_9",
			featureId: "feat_9",
			jobAttemptId: "job_9",
		});
	});
});
