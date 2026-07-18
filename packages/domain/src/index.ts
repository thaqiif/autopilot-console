/**
 * @autopilot-console/domain
 * Domain services, policies, and value objects. No adapter or app imports.
 */
export const packageName = "@autopilot-console/domain" as const;

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
