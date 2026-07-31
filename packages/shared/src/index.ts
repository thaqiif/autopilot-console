/**
 * @autopilot-console/shared
 * API contracts, validation, identifiers, redaction, and runtime config.
 * Must remain free of app and adapter imports.
 */

export const packageName = "@autopilot-console/shared" as const;

export {
	loadRuntimeConfig,
	type NodeEnv,
	type RuntimeConfig,
	type SafeRuntimeConfig,
	safeSerializeConfig,
} from "./config/runtime-config";
export type {
	ApiFailure,
	ApiResponse,
	ApiSuccess,
	CursorPage,
	RequestContext,
} from "./contracts/api";
export type {
	ActivityCategory,
	ActivityEventDraft,
	AuditEventDraft,
} from "./contracts/events";
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
} from "./contracts/ids";
export {
	formatUtcIso,
	isUtcIso,
	nowUtcIso,
	parseUtcIso,
} from "./contracts/time";
export {
	createNormalizedError,
	type ErrorCode,
	errorCodes,
	NormalizedError,
	type NormalizedErrorInit,
	type NormalizedErrorJSON,
} from "./errors/normalized-error";
export {
	type ResolvedTaskPath,
	resolveTaskPath,
	type TaskRelativePath,
} from "./fs/task-path";
export {
	type CanonicalizeOptions,
	type CanonicalWorkspacePath,
	canonicalizeWorkspacePath,
	isPathInsideRoot,
} from "./fs/workspace-path";
export {
	type FeatureBranchName,
	generateFeatureBranch,
	sanitizeSlug,
} from "./git/feature-branch";
export {
	normalizeRepositoryIdentity,
	parseGitHubRemote,
	type RepositoryIdentity,
} from "./git/repository-identity";
export {
	createOperationKey,
	type OperationKeyParts,
	type OperationName,
	type ParsedOperationKey,
	parseOperationKey,
} from "./idempotency/operation-key";
export {
	type CorrelationContext,
	type CorrelationOptions,
	type CorrelationScope,
	childCorrelation,
	createCorrelationId,
} from "./observability/correlation";
export {
	createDiagnosticLogRetention,
	type DiagnosticRetention,
	type DiagnosticRetentionOptions,
	type DiagnosticWriteInput,
} from "./observability/diagnostic-retention";
export {
	type AdapterMetrics,
	type AttentionMetrics,
	createMetricsCollector,
	type JobMetrics,
	type MetricsCollector,
	type MetricsCollectorOptions,
	type MetricsSnapshot,
	type QueueMetrics,
	type WorkerMetrics,
} from "./observability/metrics";
export {
	createStructuredLogger,
	type LogContext,
	type LogLevel,
	type StructuredLogEntry,
	type StructuredLogger,
	type StructuredLoggerOptions,
} from "./observability/structured-logger";
export { redactSecrets, redactValue } from "./security/redaction";
