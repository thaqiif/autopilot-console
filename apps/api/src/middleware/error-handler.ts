/**
 * Error mapping for the API boundary.
 * Maps thrown NormalizedError to the typed ApiFailure envelope and converts
 * unexpected errors into a safe 500 — never leaking stack traces or secrets
 * in production. Attached at the app level via app.onError (see app.ts).
 */

import {
	type ApiFailure,
	createNormalizedError,
	type ErrorCode,
	type NormalizedError,
} from "../../../../packages/shared/src/index";

const DEFAULT_NEXT_ACTION: Record<ErrorCode, string> = {
	UNAUTHORIZED: "Sign in again with valid credentials.",
	FORBIDDEN: "Confirm you are the administrator and retry.",
	NOT_FOUND: "Refresh and select a valid resource.",
	CONFLICT: "Reload the latest state and retry the action.",
	VALIDATION_FAILED: "Correct the invalid fields and resubmit.",
	IDEMPOTENCY_CONFLICT: "Use the original operation result; do not create a new one.",
	RATE_LIMITED: "Wait and retry after the rate-limit window.",
	PRECONDITION_FAILED: "Ensure lifecycle preconditions are met, then retry.",
	INTERNAL: "Retry later; if it persists, inspect server logs with the correlation ID.",
	ADAPTER_ERROR: "Inspect the external system (Git, GitHub, Autopilot) and retry.",
	UNAVAILABLE: "Wait for the dependency to recover, then retry.",
};

export function buildFailure(
	error: NormalizedError | Error,
	correlationId: string,
	nodeEnv?: string,
): ApiFailure {
	const env = nodeEnv ?? process.env.NODE_ENV ?? "development";
	const isNormalized =
		error instanceof Error &&
		(error as NormalizedError).code !== undefined &&
		(error as NormalizedError).httpStatus !== undefined;
	if (isNormalized) {
		const ne = error as NormalizedError;
		return {
			ok: false,
			error: {
				code: ne.code,
				message: ne.message,
				httpStatus: ne.httpStatus ?? 500,
				correlationId: ne.correlationId ?? correlationId,
				details: ne.details,
				nextAction: ne.nextAction,
			},
		};
	}
	const message =
		env === "production"
			? "An unexpected error occurred."
			: error.message || "An unexpected error occurred.";
	return {
		ok: false,
		error: {
			code: "INTERNAL",
			message,
			httpStatus: 500,
			correlationId,
			nextAction: DEFAULT_NEXT_ACTION.INTERNAL,
		},
	};
}

export { createNormalizedError };
