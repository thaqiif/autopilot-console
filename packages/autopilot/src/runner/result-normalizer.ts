/**
 * Normalize Autopilot run outcomes and bound/redact diagnostics.
 */

export interface ProgressSnapshot {
	total: number;
	passed: number;
	stuck: number;
	invalidTest: number;
	remaining: number;
	allPass: boolean;
	blockedReasons: Array<{ id: string; reason: string }>;
}

export type RunOutcome =
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "incomplete";

export interface NormalizedRunResult {
	exitCode: number | null;
	signal: string | null;
	outcome: RunOutcome;
	allPass: boolean;
	progress: ProgressSnapshot;
	stdoutDiagnostic: string;
	stderrDiagnostic: string;
	redactedMessage: string;
	notes?: { exists: boolean; content?: string; path?: string };
	analytics?: { exists: boolean; summary?: unknown; path?: string };
}

export function normalizeRunResult(_input: {
	exitCode: number | null;
	signal: string | null;
	progress: ProgressSnapshot;
	stdout: string;
	stderr: string;
	maxDiagnosticBytes?: number;
	notes?: NormalizedRunResult["notes"];
	analytics?: NormalizedRunResult["analytics"];
}): NormalizedRunResult {
	throw new Error("not implemented: normalizeRunResult");
}
