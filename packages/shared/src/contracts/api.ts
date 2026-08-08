import type { ErrorCode } from "../errors/normalized-error";
import type { CorrelationScope } from "../observability/correlation";

/** Envelope for successful API responses. */
export interface ApiSuccess<T> {
	ok: true;
	data: T;
	correlationId?: string;
}

/** Envelope for failed API responses — mirrors NormalizedErrorJSON. */
export interface ApiFailure {
	ok: false;
	error: {
		code: ErrorCode;
		message: string;
		httpStatus: number;
		correlationId?: string;
		details?: Record<string, unknown>;
		nextAction: string;
	};
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Common request context carried across HTTP → job → adapter boundaries. */
export interface RequestContext {
	correlationId: string;
	scope?: CorrelationScope;
	operationKey?: string;
	actorId?: string;
}

/** Pagination cursor contract for newest-first activity and similar lists. */
export interface CursorPage<T> {
	items: T[];
	nextCursor: string | null;
}
