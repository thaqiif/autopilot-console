/**
 * Read-only task file parsing with atomic-replacement tolerance.
 * Never rewrites the source file.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ParseResult } from "./task-reader-types";
import { validateTaskDocument } from "./task-semantic-validator";
import { createTaskApprovalSnapshot, type TaskApprovalSnapshot } from "./task-snapshot";

export type {
	ParsedTaskBytes,
	ParseErr,
	ParseOk,
	ParseResult,
} from "./task-reader-types";
export type {
	RequirementWire,
	TaskDocument,
	TaskRunMode,
	ValidationResult,
} from "./task-schema";
export { TASK_SCHEMA_COMPATIBILITY_VERSION } from "./task-schema";
export { validateTaskDocument } from "./task-semantic-validator";
export type { RequirementSummary, TaskApprovalSnapshot, TaskSummary } from "./task-snapshot";
export {
	createTaskApprovalSnapshot,
	evaluateAllPass,
	summarizeTaskFile,
} from "./task-snapshot";

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Parse exact source bytes: JSON parse + semantic validate + checksum.
 * Does not touch the filesystem.
 */
export function parseTaskBytes(bytes: Uint8Array | Buffer): ParseResult {
	if (bytes.byteLength === 0) {
		return { ok: false, errors: ["Empty task file"] };
	}

	const sourceBytes = bytes instanceof Buffer ? new Uint8Array(bytes) : new Uint8Array(bytes);

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
	} catch {
		return { ok: false, errors: ["Task file is not valid UTF-8"] };
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "parse error";
		return {
			ok: false,
			errors: [`Malformed or partial JSON: ${msg}`],
		};
	}

	const validated = validateTaskDocument(json);
	if (!validated.ok) {
		return { ok: false, errors: validated.errors };
	}

	return {
		ok: true,
		document: validated.document,
		runMode: validated.runMode,
		sourceBytes,
		checksum: sha256Hex(sourceBytes),
	};
}

export interface AtomicReadOptions {
	absolutePath: string;
	relativePath: string;
	/** Last known good snapshot retained across partial writes. */
	previousSnapshot?: TaskApprovalSnapshot;
	/** Total read attempts (1 = single try). Default 3. */
	maxRetries?: number;
	/** Delay between retries in ms. Default 0 (tests inject via onBeforeRead). */
	retryDelayMs?: number;
	/** Hook for tests / fake clocks — called before each read attempt. */
	onBeforeRead?: (attempt: number) => void | Promise<void>;
	/** Optional sleep implementation for production backoff. */
	sleep?: (ms: number) => Promise<void>;
}

export type AtomicReadOk = {
	ok: true;
	snapshot: TaskApprovalSnapshot;
	parsed: ParseResult & { ok: true };
};

export type AtomicReadErr = {
	ok: false;
	errors: string[];
	diagnostic: string;
	lastValidSnapshot?: TaskApprovalSnapshot;
};

export type AtomicReadResult = AtomicReadOk | AtomicReadErr;

async function defaultSleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a task file without rewriting it. Retries on partial/malformed JSON
 * and retains the last valid snapshot for diagnostics.
 */
export async function readTaskFileAtomic(options: AtomicReadOptions): Promise<AtomicReadResult> {
	const maxRetries = options.maxRetries ?? 3;
	const retryDelayMs = options.retryDelayMs ?? 0;
	const sleep = options.sleep ?? defaultSleep;
	const attempts = Math.max(1, maxRetries);
	let lastErrors: string[] = [];

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		if (options.onBeforeRead) {
			await options.onBeforeRead(attempt);
		}

		let bytes: Buffer;
		try {
			bytes = await readFile(options.absolutePath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "read failed";
			lastErrors = [`Failed to read task file: ${msg}`];
			if (attempt < attempts) {
				await sleep(retryDelayMs);
				continue;
			}
			break;
		}

		const parsed = parseTaskBytes(bytes);
		if (parsed.ok) {
			const snapshot = createTaskApprovalSnapshot({
				parsed,
				relativePath: options.relativePath,
			});
			return { ok: true, snapshot, parsed };
		}

		lastErrors = parsed.errors;
		if (attempt < attempts) {
			await sleep(retryDelayMs);
		}
	}

	return {
		ok: false,
		errors: lastErrors,
		diagnostic: `Malformed or partial JSON after ${attempts} attempt(s): ${lastErrors.join("; ")}`,
		lastValidSnapshot: options.previousSnapshot,
	};
}
