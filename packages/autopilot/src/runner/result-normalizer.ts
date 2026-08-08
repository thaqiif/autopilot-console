/**
 * Normalize Autopilot run outcomes and bound/redact diagnostics.
 */

import { redactSecrets } from "../../../shared/src/security/redaction";

export interface ProgressSnapshot {
	total: number;
	passed: number;
	stuck: number;
	invalidTest: number;
	remaining: number;
	allPass: boolean;
	blockedReasons: Array<{ id: string; reason: string }>;
}

export type RunOutcome = "succeeded" | "failed" | "cancelled" | "interrupted" | "incomplete";

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

const DEFAULT_MAX = 64 * 1024;

function boundDiagnostic(text: string, maxBytes: number): string {
	// Truncate first so redaction never scans multi-megabyte buffers.
	const raw = Buffer.from(text ?? "", "utf8");
	const marker = "\n…[TRUNCATED]";
	const keep = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	const truncated =
		raw.byteLength <= maxBytes ? text : `${raw.subarray(0, keep).toString("utf8")}${marker}`;
	return redactSecrets(truncated);
}

function classifyOutcome(input: {
	exitCode: number | null;
	signal: string | null;
	allPass: boolean;
}): RunOutcome {
	if (input.signal === "SIGUSR1") return "cancelled";
	if (input.signal === "SIGKILL" || input.signal === "SIGTERM") {
		return "interrupted";
	}
	if (input.exitCode === 0 && input.allPass) return "succeeded";
	if (input.exitCode === 0 && !input.allPass) return "incomplete";
	if (input.exitCode == null) return "interrupted";
	return "failed";
}

export function normalizeRunResult(input: {
	exitCode: number | null;
	signal: string | null;
	progress: ProgressSnapshot;
	stdout: string;
	stderr: string;
	maxDiagnosticBytes?: number;
	notes?: NormalizedRunResult["notes"];
	analytics?: NormalizedRunResult["analytics"];
}): NormalizedRunResult {
	const max = input.maxDiagnosticBytes ?? DEFAULT_MAX;
	const stdoutDiagnostic = boundDiagnostic(input.stdout ?? "", max);
	const stderrDiagnostic = boundDiagnostic(input.stderr ?? "", max);
	const notes = input.notes
		? {
				...input.notes,
				content: input.notes.content != null ? redactSecrets(input.notes.content) : undefined,
			}
		: undefined;
	const allPass = input.progress.allPass === true;
	const outcome = classifyOutcome({
		exitCode: input.exitCode,
		signal: input.signal,
		allPass,
	});
	const redactedMessage = redactSecrets(
		outcome === "succeeded"
			? "Autopilot run succeeded"
			: `Autopilot run ${outcome}` +
					(input.exitCode != null ? ` (exit ${input.exitCode})` : "") +
					(input.signal ? ` signal=${input.signal}` : ""),
	);

	return {
		exitCode: input.exitCode,
		signal: input.signal,
		outcome,
		allPass,
		progress: input.progress,
		stdoutDiagnostic,
		stderrDiagnostic,
		redactedMessage,
		notes,
		analytics: input.analytics,
	};
}
