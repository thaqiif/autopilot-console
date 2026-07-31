import { describe, expect, test } from "bun:test";
import { createDiagnosticLogRetention } from "./diagnostic-retention";

describe("diagnostic log retention", () => {
	test("writes redacted bounded diagnostic files under the configured root", async () => {
		const files = new Map<string, string>();
		const retention = createDiagnosticLogRetention({
			rootDir: "/app/logs",
			maxFileBytes: 120,
			now: () => new Date("2026-07-31T12:00:00.000Z"),
			fs: {
				mkdir: async () => undefined,
				readdir: async () => [...files.keys()].map((path) => path.split("/").pop() ?? path),
				stat: async (path) => {
					const body = files.get(path) ?? "";
					return {
						size: Buffer.byteLength(body, "utf8"),
						mtimeMs: Date.parse("2026-07-31T12:00:00.000Z"),
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

		const written = await retention.write({
			stream: "stderr",
			body: `token=ghp_abcdefghijklmnopqrstuvwxyz ${"x".repeat(400)}`,
			projectId: "proj_1",
			featureId: "feat_1",
			jobAttemptId: "attempt_1",
			correlationId: "corr_1",
		});

		expect(written.startsWith("/app/logs/")).toBe(true);
		expect(written.endsWith(".log")).toBe(true);
		const payload = [...files.values()][0] ?? "";
		expect(payload).not.toContain("ghp_");
		expect(payload).toContain("[REDACTED]");
		expect(payload).toContain("…[TRUNCATED]");
		expect(payload).toContain("attempt_1");
	});

	test("prunes aged and oversized diagnostic files", async () => {
		const files = new Map<string, { body: string; mtimeMs: number }>([
			[
				"/app/logs/old.log",
				{ body: "a".repeat(100), mtimeMs: Date.parse("2026-01-01T00:00:00.000Z") },
			],
			[
				"/app/logs/keep.log",
				{ body: "b".repeat(40), mtimeMs: Date.parse("2026-07-30T00:00:00.000Z") },
			],
			[
				"/app/logs/mid.log",
				{ body: "c".repeat(40), mtimeMs: Date.parse("2026-07-29T00:00:00.000Z") },
			],
		]);
		const retention = createDiagnosticLogRetention({
			rootDir: "/app/logs",
			maxTotalBytes: 50,
			maxAgeMs: 2 * 24 * 60 * 60 * 1000,
			now: () => new Date("2026-07-31T00:00:00.000Z"),
			fs: {
				mkdir: async () => undefined,
				readdir: async () => ["old.log", "keep.log", "mid.log"],
				stat: async (path) => {
					const entry = files.get(path);
					if (!entry) throw new Error(`missing ${path}`);
					return { size: Buffer.byteLength(entry.body, "utf8"), mtimeMs: entry.mtimeMs };
				},
				unlink: async (path) => {
					files.delete(path);
				},
				writeFile: async () => undefined,
			},
		});

		const result = await retention.prune();
		expect(files.has("/app/logs/old.log")).toBe(false);
		expect(result.removed).toBeGreaterThanOrEqual(2);
		expect(result.remainingBytes).toBeLessThanOrEqual(50);
		expect(files.size).toBe(1);
		expect(files.has("/app/logs/keep.log")).toBe(true);
	});
});
