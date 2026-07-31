/**
 * Bounded diagnostic log retention for worker file storage.
 *
 * Writes redacted diagnostic chunks under a dedicated directory and prunes by
 * total size and age so the diagnostic volume cannot grow unbounded. Per-attempt
 * byte budgets are enforced with explicit truncation markers while preserving
 * structured progress/audit correlation fields on every record.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../security/redaction";
import { PRODUCTION_DIAGNOSTIC_LIMITS } from "./runtime-metrics";

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
	/** Cumulative diagnostic body bytes allowed for a single job attempt. */
	maxPerAttemptBytes?: number;
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

const TRUNCATION_MARKER = "…[TRUNCATED]";

function boundBody(body: string, maxFileBytes: number): { body: string; truncated: boolean } {
	const redacted = redactSecrets(body);
	const encoded = Buffer.from(redacted, "utf8");
	if (encoded.byteLength <= maxFileBytes) return { body: redacted, truncated: false };
	const budget = Math.max(0, maxFileBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
	return {
		body: `${encoded.subarray(0, budget).toString("utf8")}${TRUNCATION_MARKER}`,
		truncated: true,
	};
}

function safeSegment(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || fallback;
}

export function createDiagnosticLogRetention(
	options: DiagnosticRetentionOptions,
): DiagnosticRetention {
	const rootDir = options.rootDir;
	const maxFileBytes = options.maxFileBytes ?? PRODUCTION_DIAGNOSTIC_LIMITS.maxFileBytes;
	const maxPerAttemptBytes =
		options.maxPerAttemptBytes ?? PRODUCTION_DIAGNOSTIC_LIMITS.maxPerAttemptBytes;
	const maxTotalBytes = options.maxTotalBytes ?? PRODUCTION_DIAGNOSTIC_LIMITS.maxTotalBytes;
	const maxAgeMs = options.maxAgeMs ?? PRODUCTION_DIAGNOSTIC_LIMITS.maxAgeMs;
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
	const attemptBytes = new Map<string, number>();

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
			const attemptKey = safeSegment(input.jobAttemptId, "job");
			const name = `${[
				stamp,
				attemptKey,
				safeSegment(input.stream, "out"),
				String(sequence).padStart(4, "0"),
			].join("_")}.log`;
			const path = join(rootDir, name);

			const used = attemptBytes.get(attemptKey) ?? 0;
			const remainingAttemptBudget = Math.max(0, maxPerAttemptBytes - used);
			const fileBudget = Math.min(maxFileBytes, remainingAttemptBudget);

			let bodyText: string;
			let truncated: boolean;
			if (fileBudget <= 0) {
				// Per-attempt budget exhausted — still write a structured truncation record
				// so progress/audit correlation survives while body growth stops.
				bodyText = TRUNCATION_MARKER;
				truncated = true;
			} else {
				const bounded = boundBody(input.body, fileBudget);
				bodyText = bounded.body;
				truncated = bounded.truncated || Buffer.byteLength(input.body, "utf8") > fileBudget;
			}

			const payloadObject = {
				timestamp: now().toISOString(),
				stream: input.stream,
				projectId: input.projectId,
				featureId: input.featureId,
				jobAttemptId: input.jobAttemptId,
				correlationId: input.correlationId,
				truncated,
				body: bodyText,
			};
			const payload = `${JSON.stringify(payloadObject)}\n`;
			attemptBytes.set(attemptKey, used + Buffer.byteLength(bodyText, "utf8"));
			await writeFileFn(path, payload, "utf8");
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
