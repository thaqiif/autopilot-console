/**
 * @autopilot-console/shared
 * API contracts, validation, identifiers, redaction, and runtime config.
 * Must remain free of app and adapter imports.
 */

export const packageName = "@autopilot-console/shared" as const;

export {
	loadRuntimeConfig,
	safeSerializeConfig,
	type NodeEnv,
	type RuntimeConfig,
	type SafeRuntimeConfig,
} from "./config/runtime-config.ts";

export {
	asFeatureId,
	asJobAttemptId,
	asProjectId,
	asPullRequestId,
	asReleaseId,
	asSessionId,
	type FeatureId,
	type JobAttemptId,
	type ProjectId,
	type PullRequestId,
	type ReleaseId,
	type SessionId,
} from "./contracts/ids.ts";

export {
	formatUtcIso,
	isUtcIso,
	nowUtcIso,
	parseUtcIso,
} from "./contracts/time.ts";

export type {
	ApiFailure,
	ApiResponse,
	ApiSuccess,
	CursorPage,
	RequestContext,
} from "./contracts/api.ts";

export type {
	ActivityCategory,
	ActivityEventDraft,
	AuditEventDraft,
} from "./contracts/events.ts";

export {
	createOperationKey,
	parseOperationKey,
	type OperationKeyParts,
	type OperationName,
	type ParsedOperationKey,
} from "./idempotency/operation-key.ts";

export {
	childCorrelation,
	createCorrelationId,
	type CorrelationContext,
	type CorrelationOptions,
	type CorrelationScope,
} from "./observability/correlation.ts";

export {
	createNormalizedError,
	errorCodes,
	NormalizedError,
	type ErrorCode,
	type NormalizedErrorInit,
	type NormalizedErrorJSON,
} from "./errors/normalized-error.ts";

export { redactSecrets, redactValue } from "./security/redaction.ts";
