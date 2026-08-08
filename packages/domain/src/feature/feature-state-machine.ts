import { FEATURE_STATES, type FeatureState, isTerminalFeatureState } from "./feature-state";
import type {
	AppliedFeatureTransition,
	FeatureTransitionCommand,
	FeatureTransitionEvent,
	FeatureTransitionOptions,
	FeatureTransitionResult,
	TransitionOwner,
} from "./feature-transition";

export {
	FEATURE_STATES,
	type FeatureState,
	isFeatureState,
	isTerminalFeatureState,
	TERMINAL_FEATURE_STATES,
} from "./feature-state";
export type {
	AppliedFeatureTransition,
	FeatureTransitionCommand,
	FeatureTransitionEvent,
	FeatureTransitionOptions,
	FeatureTransitionResult,
	IdempotentFeatureTransition,
	RejectedFeatureTransition,
	TransitionOwner,
	TransitionRejectionReason,
} from "./feature-transition";

interface TransitionEdge {
	from: FeatureState;
	to: FeatureState;
	owner: TransitionOwner;
}

/**
 * Declarative F-5 transition table. Exhaustiveness of FEATURE_STATES is
 * enforced at compile time via the satisfies-adjacent checks below and the
 * matrix unit suite. BLOCKED from any nonterminal is handled separately so
 * the table stays one row per explicit business edge.
 */
const EXPLICIT_EDGES = [
	{ from: "PLANNED", to: "TASKS_REVIEW", owner: "human_and_validation" },
	{ from: "TASKS_REVIEW", to: "PLANNED", owner: "human" },
	{ from: "TASKS_REVIEW", to: "QUEUED", owner: "human" },
	{ from: "QUEUED", to: "DEVELOPING", owner: "worker" },
	{ from: "QUEUED", to: "DEVELOPMENT_CANCELLED", owner: "human" },
	{ from: "DEVELOPING", to: "DEVELOPMENT_COMPLETE", owner: "agent_result_and_verification" },
	{ from: "DEVELOPING", to: "DEVELOPMENT_FAILED", owner: "worker" },
	{ from: "DEVELOPING", to: "DEVELOPMENT_INTERRUPTED", owner: "reconciliation" },
	{ from: "DEVELOPING", to: "DEVELOPMENT_CANCELLED", owner: "human_and_process_control" },
	{ from: "DEVELOPMENT_FAILED", to: "QUEUED", owner: "human" },
	{ from: "DEVELOPMENT_INTERRUPTED", to: "QUEUED", owner: "human" },
	{ from: "DEVELOPMENT_CANCELLED", to: "QUEUED", owner: "human" },
	{ from: "DEVELOPMENT_COMPLETE", to: "PR_CREATING", owner: "worker" },
	{ from: "PR_CREATING", to: "CI_RUNNING", owner: "github_adapter" },
	{ from: "PR_CREATING", to: "PR_CREATION_FAILED", owner: "github_adapter" },
	{ from: "PR_CREATION_FAILED", to: "PR_CREATING", owner: "human" },
	{ from: "CI_RUNNING", to: "CI_FAILED", owner: "poller" },
	{ from: "CI_RUNNING", to: "PR_REVIEW", owner: "poller" },
	{ from: "CI_FAILED", to: "CI_RUNNING", owner: "poller" },
	{ from: "CI_FAILED", to: "PR_REVIEW", owner: "poller" },
	{ from: "PR_REVIEW", to: "PR_CHANGES_REQUESTED", owner: "poller" },
	{ from: "PR_CHANGES_REQUESTED", to: "CI_RUNNING", owner: "poller" },
	{ from: "PR_CHANGES_REQUESTED", to: "PR_REVIEW", owner: "poller" },
	// Any PR state → DEVELOPMENT_MERGED
	{ from: "PR_CREATING", to: "DEVELOPMENT_MERGED", owner: "poller" },
	{ from: "PR_CREATION_FAILED", to: "DEVELOPMENT_MERGED", owner: "poller" },
	{ from: "CI_RUNNING", to: "DEVELOPMENT_MERGED", owner: "poller" },
	{ from: "CI_FAILED", to: "DEVELOPMENT_MERGED", owner: "poller" },
	{ from: "PR_REVIEW", to: "DEVELOPMENT_MERGED", owner: "poller" },
	{ from: "PR_CHANGES_REQUESTED", to: "DEVELOPMENT_MERGED", owner: "poller" },
] as const satisfies readonly TransitionEdge[];

function edgeKey(from: FeatureState, to: FeatureState, owner: TransitionOwner): string {
	return `${from}|${to}|${owner}`;
}

const EDGE_LOOKUP: ReadonlySet<string> = (() => {
	const set = new Set<string>();
	for (const edge of EXPLICIT_EDGES) {
		set.add(edgeKey(edge.from, edge.to, edge.owner));
	}
	// Any nonterminal → BLOCKED via deterministic guard only
	for (const from of FEATURE_STATES) {
		if (from === "DEVELOPMENT_MERGED") continue;
		set.add(edgeKey(from, "BLOCKED", "guard"));
	}
	return set;
})();

const EDGES_BY_FROM: ReadonlyMap<
	FeatureState,
	ReadonlyArray<{ to: FeatureState; owner: TransitionOwner }>
> = (() => {
	const map = new Map<FeatureState, Array<{ to: FeatureState; owner: TransitionOwner }>>();
	for (const state of FEATURE_STATES) {
		map.set(state, []);
	}
	for (const edge of EXPLICIT_EDGES) {
		map.get(edge.from)?.push({ to: edge.to, owner: edge.owner });
	}
	for (const from of FEATURE_STATES) {
		if (from === "DEVELOPMENT_MERGED") continue;
		map.get(from)?.push({ to: "BLOCKED", owner: "guard" });
	}
	return map;
})();

function toUtcIso(date: Date): string {
	return date.toISOString();
}

function isAllowed(from: FeatureState, to: FeatureState, owner: TransitionOwner): boolean {
	if (isTerminalFeatureState(from)) return false;
	return EDGE_LOOKUP.has(edgeKey(from, to, owner));
}

/**
 * Enumerate allowed outbound edges for a state (including BLOCKED for nonterminals).
 * DEVELOPMENT_MERGED returns [].
 */
export function listAllowedTransitions(
	from: FeatureState,
): ReadonlyArray<{ to: FeatureState; owner: TransitionOwner }> {
	return EDGES_BY_FROM.get(from) ?? [];
}

/**
 * Single deterministic feature state-transition service.
 * Controllers and workers must request transitions through this function only.
 */
export function applyFeatureTransition(
	command: FeatureTransitionCommand,
	options: FeatureTransitionOptions = {},
): FeatureTransitionResult {
	const now = options.now ?? (() => new Date());

	// Idempotent hit: same operation already applied — return prior, emit nothing.
	if (
		command.priorAppliedOperationId !== undefined &&
		command.priorAppliedOperationId === command.operationId &&
		command.priorAppliedResult !== undefined
	) {
		return {
			kind: "idempotent",
			result: command.priorAppliedResult,
			emitted: false,
		};
	}

	// Optimistic concurrency: row version
	if (command.expectedVersion !== command.currentVersion) {
		return {
			kind: "rejected",
			reason: "version_conflict",
			priorState: command.from,
			nextState: command.from,
			message: `Feature version conflict: expected ${command.expectedVersion}, current ${command.currentVersion}`,
		};
	}

	// Expected prior state vs observed storage state
	if (command.observedState !== undefined && command.observedState !== command.from) {
		return {
			kind: "rejected",
			reason: "state_conflict",
			priorState: command.observedState,
			nextState: command.observedState,
			message: `Feature state conflict: expected ${command.from}, observed ${command.observedState}`,
		};
	}

	if (!isAllowed(command.from, command.to, command.owner)) {
		return {
			kind: "rejected",
			reason: "forbidden_transition",
			priorState: command.from,
			nextState: command.from,
			message: `Forbidden transition ${command.from} → ${command.to} by ${command.owner}`,
		};
	}

	const timestamp = toUtcIso(now());
	const priorVersion = command.currentVersion;
	const nextVersion = priorVersion + 1;
	const event: FeatureTransitionEvent = {
		type: "feature.transitioned",
		featureId: command.featureId,
		from: command.from,
		to: command.to,
		owner: command.owner,
		cause: command.cause,
		operationId: command.operationId,
		timestamp,
		priorVersion,
		nextVersion,
	};

	const applied: AppliedFeatureTransition = {
		kind: "applied",
		featureId: command.featureId,
		priorState: command.from,
		nextState: command.to,
		owner: command.owner,
		cause: command.cause,
		operationId: command.operationId,
		timestamp,
		priorVersion,
		nextVersion,
		event,
	};
	return applied;
}
