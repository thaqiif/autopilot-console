import type { FeatureState } from "./feature-state";

/** Who may fire a transition. Controllers/workers must pass the real owner. */
export type TransitionOwner =
	| "human"
	| "human_and_validation"
	| "human_and_process_control"
	| "worker"
	| "agent_result_and_verification"
	| "reconciliation"
	| "github_adapter"
	| "poller"
	| "guard";

export type TransitionRejectionReason =
	| "forbidden_transition"
	| "state_conflict"
	| "version_conflict";

export interface FeatureTransitionCommand {
	featureId: string;
	from: FeatureState;
	to: FeatureState;
	owner: TransitionOwner;
	cause: string;
	operationId: string;
	/** Optimistic concurrency: version the caller expects. */
	expectedVersion: number;
	/** Version currently observed in storage. */
	currentVersion: number;
	/**
	 * Optional observed state from storage. When set and different from `from`,
	 * the transition is rejected as a state conflict (no mutation).
	 */
	observedState?: FeatureState;
	/**
	 * When replaying an already-applied operation, supply the prior applied
	 * operation id and result so the service can return an idempotent hit.
	 */
	priorAppliedOperationId?: string;
	priorAppliedResult?: AppliedFeatureTransition;
}

export interface FeatureTransitionEvent {
	type: "feature.transitioned";
	featureId: string;
	from: FeatureState;
	to: FeatureState;
	owner: TransitionOwner;
	cause: string;
	operationId: string;
	timestamp: string;
	priorVersion: number;
	nextVersion: number;
}

export interface AppliedFeatureTransition {
	kind: "applied";
	featureId: string;
	priorState: FeatureState;
	nextState: FeatureState;
	owner: TransitionOwner;
	cause: string;
	operationId: string;
	timestamp: string;
	priorVersion: number;
	nextVersion: number;
	event: FeatureTransitionEvent;
}

export interface IdempotentFeatureTransition {
	kind: "idempotent";
	/** Original applied result for this operation identity. */
	result: AppliedFeatureTransition;
	/** Always false — no second transition event is emitted. */
	emitted: false;
}

export interface RejectedFeatureTransition {
	kind: "rejected";
	reason: TransitionRejectionReason;
	priorState: FeatureState;
	/** Unchanged state after rejection. */
	nextState: FeatureState;
	message: string;
}

export type FeatureTransitionResult =
	| AppliedFeatureTransition
	| IdempotentFeatureTransition
	| RejectedFeatureTransition;

export interface FeatureTransitionOptions {
	/** Injectable clock; defaults to wall clock. Always returns UTC ISO. */
	now?: () => Date;
}
