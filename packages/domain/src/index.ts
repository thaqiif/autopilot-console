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

export {
	computeDevelopmentProgress,
	type DevelopmentProgress,
	type FeatureForProgress,
	RELEASE_DEVELOPMENT_STATUSES,
	type ReleaseDevelopmentStatus,
} from "./release/development-progress";
