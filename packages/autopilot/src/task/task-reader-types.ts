import type { TaskDocument, TaskRunMode } from "./task-schema";

export interface ParsedTaskBytes {
	document: TaskDocument;
	runMode: TaskRunMode;
	/** Exact source bytes that produced this parse. */
	sourceBytes: Uint8Array;
	/** SHA-256 hex of sourceBytes. */
	checksum: string;
}

export type ParseOk = { ok: true } & ParsedTaskBytes;

export type ParseErr = {
	ok: false;
	errors: string[];
};

export type ParseResult = ParseOk | ParseErr;
