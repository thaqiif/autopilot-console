import { redactValue } from "../security/redaction.ts";

export const errorCodes = {
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	VALIDATION_FAILED: "VALIDATION_FAILED",
	IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
	RATE_LIMITED: "RATE_LIMITED",
	PRECONDITION_FAILED: "PRECONDITION_FAILED",
	INTERNAL: "INTERNAL",
	ADAPTER_ERROR: "ADAPTER_ERROR",
	UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

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

export interface NormalizedErrorInit {
	code: ErrorCode;
	message: string;
	httpStatus: number;
	correlationId?: string;
	details?: Record<string, unknown>;
	nextAction?: string;
	cause?: unknown;
}

export interface NormalizedErrorJSON {
	code: ErrorCode;
	message: string;
	httpStatus: number;
	correlationId?: string;
	details?: Record<string, unknown>;
	nextAction: string;
}

export class NormalizedError extends Error {
	readonly code: ErrorCode;
	readonly httpStatus: number;
	readonly correlationId?: string;
	readonly details?: Record<string, unknown>;
	readonly nextAction: string;

	constructor(init: NormalizedErrorInit) {
		super(init.message);
		this.name = "NormalizedError";
		this.code = init.code;
		this.httpStatus = init.httpStatus;
		this.correlationId = init.correlationId;
		this.details = init.details
			? (redactValue(init.details) as Record<string, unknown>)
			: undefined;
		this.nextAction = init.nextAction ?? DEFAULT_NEXT_ACTION[init.code];
		if (init.cause !== undefined) {
			this.cause = init.cause;
		}
	}

	toJSON(): NormalizedErrorJSON {
		return {
			code: this.code,
			message: this.message,
			httpStatus: this.httpStatus,
			correlationId: this.correlationId,
			details: this.details,
			nextAction: this.nextAction,
		};
	}
}

export function createNormalizedError(init: NormalizedErrorInit): NormalizedError {
	return new NormalizedError(init);
}
