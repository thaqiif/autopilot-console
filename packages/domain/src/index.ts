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
	PROJECT_VALIDATION_CHECK_CODES,
	type ProjectValidationCheck,
	type ProjectValidationCheckCode,
	type ProjectValidationInput,
	type ProjectValidationResult,
} from "./project/project-validation";
export {
	computeDevelopmentProgress,
	type DevelopmentProgress,
	type FeatureForProgress,
	RELEASE_DEVELOPMENT_STATUSES,
	type ReleaseDevelopmentStatus,
} from "./release/development-progress";
