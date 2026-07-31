/**
 * Bounded diagnostic log retention for worker file storage.
 *
 * Writes redacted diagnostic chunks under a dedicated directory and prunes by
 * total size and age so the diagnostic volume cannot grow unbounded.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../security/redaction";

export interface DiagnosticFs {
	mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<{ size: number; mtimeMs: number }>;
	unlink(path: string): Promise<unknown>;
	writeFile(path: string, body: string, encoding?: BufferEncoding): Promise<unknown>;
}

export interface DiagnosticRetentionOptions {
	rootDir: string;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	maxAgeMs?: number;
	now?: () => Date;
	fs?: Partial<DiagnosticFs>;
}

export interface DiagnosticWriteInput {
	stream: "stdout" | "stderr";
	body: string;
	projectId?: string;
	featureId?: string;
	jobAttemptId?: string;
	correlationId?: string;
}

export interface DiagnosticRetention {
	write(input: DiagnosticWriteInput): Promise<string>;
	prune(): Promise<{ removed: number; remainingBytes: number }>;
	readonly rootDir: string;
}

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TRUNCATION_MARKER = "\n…[TRUNCATED]";

function boundBody(body: string, maxFileBytes: number): string {
	const redacted = redactSecrets(body);
	const encoded = Buffer.from(redacted, "utf8");
	if (encoded.byteLength <= maxFileBytes) return redacted;
	const budget = Math.max(0, maxFileBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
	return `${encoded.subarray(0, budget).toString("utf8")}${TRUNCATION_MARKER}`;
}

function safeSegment(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || fallback;
}

export function createDiagnosticLogRetention(
	options: DiagnosticRetentionOptions,
): DiagnosticRetention {
	const rootDir = options.rootDir;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = options.now ?? (() => new Date());
	const mkdirFn = options.fs?.mkdir ?? ((path, opts) => mkdir(path, opts));
	const readdirFn = options.fs?.readdir ?? (async (path) => (await readdir(path)) as string[]);
	const statFn =
		options.fs?.stat ??
		(async (path) => {
			const info = await stat(path);
			return { size: info.size, mtimeMs: info.mtimeMs };
		});
	const unlinkFn = options.fs?.unlink ?? ((path) => unlink(path));
	const writeFileFn =
		options.fs?.writeFile ?? ((path, body, encoding) => writeFile(path, body, encoding));
	let sequence = 0;

	async function ensureRoot(): Promise<void> {
		await mkdirFn(rootDir, { recursive: true });
	}

	async function listEntries(): Promise<
		Array<{ name: string; path: string; size: number; mtimeMs: number }>
	> {
		await ensureRoot();
		const names = await readdirFn(rootDir);
		const entries: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
		for (const name of names) {
			if (!name.endsWith(".log")) continue;
			const path = join(rootDir, name);
			const info = await statFn(path);
			entries.push({
				name,
				path,
				size: info.size,
				mtimeMs: info.mtimeMs,
			});
		}
		return entries;
	}

	return {
		rootDir,
		async write(input) {
			await ensureRoot();
			sequence += 1;
			const stamp = now().toISOString().replace(/[:.]/g, "-");
			const name = `${[
				stamp,
				safeSegment(input.jobAttemptId, "job"),
				safeSegment(input.stream, "out"),
				String(sequence).padStart(4, "0"),
			].join("_")}.log`;
			const path = join(rootDir, name);
			const payload = JSON.stringify({
				timestamp: now().toISOString(),
				stream: input.stream,
				projectId: input.projectId,
				featureId: input.featureId,
				jobAttemptId: input.jobAttemptId,
				correlationId: input.correlationId,
				body: boundBody(input.body, maxFileBytes),
			});
			await writeFileFn(path, `${payload}\n`, "utf8");
			return path;
		},
		async prune() {
			const entries = await listEntries();
			const cutoff = now().getTime() - maxAgeMs;
			let removed = 0;
			const keep: typeof entries = [];
			for (const entry of entries) {
				if (entry.mtimeMs < cutoff) {
					await unlinkFn(entry.path);
					removed += 1;
					continue;
				}
				keep.push(entry);
			}
			keep.sort((a, b) => a.mtimeMs - b.mtimeMs);
			let remainingBytes = keep.reduce((sum, entry) => sum + entry.size, 0);
			while (remainingBytes > maxTotalBytes && keep.length > 0) {
				const oldest = keep.shift();
				if (!oldest) break;
				await unlinkFn(oldest.path);
				remainingBytes -= oldest.size;
				removed += 1;
			}
			return { removed, remainingBytes };
		},
	};
}
