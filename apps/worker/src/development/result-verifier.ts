import type { NormalizedRunResult } from "../../../../packages/autopilot/src/index";
import type { FailureKind } from "../../../../packages/domain/src/index";

export interface VerifiedDevelopmentSuccess {
	ok: true;
	result: NormalizedRunResult;
}

export interface VerifiedDevelopmentFailure {
	ok: false;
	failureKind: Extract<FailureKind, "process" | "task_result">;
	reason: string;
	result: NormalizedRunResult;
}

export type VerifiedDevelopmentResult = VerifiedDevelopmentSuccess | VerifiedDevelopmentFailure;

export function verifyDevelopmentResult(result: NormalizedRunResult): VerifiedDevelopmentResult {
	const terminalProgressIsComplete =
		result.progress.total > 0 &&
		result.progress.passed === result.progress.total &&
		result.progress.remaining === 0 &&
		result.progress.stuck === 0 &&
		result.progress.invalidTest === 0;
	const processSucceeded =
		result.exitCode === 0 &&
		result.signal === null &&
		result.outcome === "succeeded" &&
		result.allPass === true;

	if (processSucceeded && terminalProgressIsComplete) {
		return { ok: true, result };
	}

	const processFailed =
		result.exitCode !== 0 ||
		result.signal !== null ||
		result.outcome === "failed" ||
		result.outcome === "interrupted" ||
		result.outcome === "cancelled";
	return {
		ok: false,
		failureKind: processFailed ? "process" : "task_result",
		reason: processFailed
			? result.redactedMessage
			: "Structured task result contains stuck, invalid, unpassed, or malformed progress.",
		result,
	};
}
