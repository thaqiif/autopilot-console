/**
 * @autopilot-console/domain
 * Domain services, policies, and value objects. No adapter or app imports.
 */
export const packageName = "@autopilot-console/domain" as const;

export {
	ATTENTION_ACTIONS,
	ATTENTION_CATEGORIES,
	type AttentionAction,
	type AttentionCategory,
	type AttentionInput,
	type AttentionItem,
	deriveAttention,
	deriveAttentionForFeatures,
} from "./attention/attention-policy";
export {
	FAILURE_KINDS,
	type FailureAttentionCategory,
	type FailureKind,
	type FailureProjection,
	type FailureRecommendedAction,
	type MapFailureInput,
	mapFailure,
} from "./failure/failure-policy";
export type { Feature } from "./feature/feature";
export {
	type CreateFeatureResult,
	createFeatureService,
	type FeatureMutationFailureReason,
	type FeatureService,
	type FeatureServiceOptions,
	type UpdateFeatureResult,
} from "./feature/feature-service";
export {
	type AppliedFeatureTransition,
	applyFeatureTransition,
	FEATURE_STATES,
	type FeatureState,
	type FeatureTransitionCommand,
	type FeatureTransitionEvent,
	type FeatureTransitionOptions,
	type FeatureTransitionResult,
	type IdempotentFeatureTransition,
	isFeatureState,
	isTerminalFeatureState,
	listAllowedTransitions,
	type RejectedFeatureTransition,
	TERMINAL_FEATURE_STATES,
	type TransitionOwner,
	type TransitionRejectionReason,
} from "./feature/feature-state-machine";
export type { Project, ProjectActor, ProjectStatus } from "./project/project";
export {
	type ArchiveProjectResult,
	type CreateProjectResult,
	createProjectService,
	type ProjectMutationFailureReason,
	type ProjectService,
	type ProjectServiceOptions,
	type UpdateProjectResult,
} from "./project/project-service";
export {
	aggregateValidationOk,
	PROJECT_VALIDATION_CHECK_CODES,
	PROTECTED_PROJECT_FIELDS,
	type ProjectFieldChange,
	type ProjectValidationCheck,
	type ProjectValidationCheckCode,
	type ProjectValidationInput,
	type ProjectValidationResult,
	type ProtectedProjectField,
	touchesProtectedProjectFields,
} from "./project/project-validation";
export {
	computeDevelopmentProgress,
	type DevelopmentProgress,
	type FeatureForProgress,
	RELEASE_DEVELOPMENT_STATUSES,
	type ReleaseDevelopmentStatus,
} from "./release/development-progress";
export type { Release, ReleaseStatus } from "./release/release";
export {
	type ArchiveReleaseResult,
	type CreateReleaseResult,
	createReleaseService,
	type ReleaseMutationFailureReason,
	type ReleaseProgressResult,
	type ReleaseService,
	type ReleaseServiceOptions,
	type UpdateReleaseResult,
} from "./release/release-service";
