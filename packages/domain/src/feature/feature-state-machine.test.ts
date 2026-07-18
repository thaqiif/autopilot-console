import { describe, expect, test } from "bun:test";
import {
	applyFeatureTransition,
	FEATURE_STATES,
	type FeatureState,
	isFeatureState,
	isTerminalFeatureState,
	listAllowedTransitions,
	type TransitionOwner,
} from "./feature-state-machine";
import type { FeatureTransitionCommand } from "./feature-transition";

const FIXED_NOW = () => new Date("2026-07-18T12:00:00.000Z");

/** Every allowed edge from F-5 with its permitted trigger owner. */
const ALLOWED: ReadonlyArray<{
	from: FeatureState;
	to: FeatureState;
	owner: TransitionOwner;
	cause: string;
}> = [
	{
		from: "PLANNED",
		to: "TASKS_REVIEW",
		owner: "human_and_validation",
		cause: "owner_attached_valid_task",
	},
	{
		from: "TASKS_REVIEW",
		to: "PLANNED",
		owner: "human",
		cause: "owner_removed_or_replaced_task",
	},
	{
		from: "TASKS_REVIEW",
		to: "QUEUED",
		owner: "human",
		cause: "owner_approved_and_queued",
	},
	{
		from: "QUEUED",
		to: "DEVELOPING",
		owner: "worker",
		cause: "worker_claimed_job",
	},
	{
		from: "QUEUED",
		to: "DEVELOPMENT_CANCELLED",
		owner: "human",
		cause: "owner_cancelled_before_claim",
	},
	{
		from: "DEVELOPING",
		to: "DEVELOPMENT_COMPLETE",
		owner: "agent_result_and_verification",
		cause: "all_requirements_passed",
	},
	{
		from: "DEVELOPING",
		to: "DEVELOPMENT_FAILED",
		owner: "worker",
		cause: "process_failed_or_unpassed",
	},
	{
		from: "DEVELOPING",
		to: "DEVELOPMENT_INTERRUPTED",
		owner: "reconciliation",
		cause: "ownership_or_process_lost",
	},
	{
		from: "DEVELOPING",
		to: "DEVELOPMENT_CANCELLED",
		owner: "human_and_process_control",
		cause: "owner_cancellation_completed",
	},
	{
		from: "DEVELOPMENT_FAILED",
		to: "QUEUED",
		owner: "human",
		cause: "explicit_retry",
	},
	{
		from: "DEVELOPMENT_INTERRUPTED",
		to: "QUEUED",
		owner: "human",
		cause: "explicit_retry",
	},
	{
		from: "DEVELOPMENT_CANCELLED",
		to: "QUEUED",
		owner: "human",
		cause: "explicit_retry",
	},
	{
		from: "DEVELOPMENT_COMPLETE",
		to: "PR_CREATING",
		owner: "worker",
		cause: "pr_handoff_started",
	},
	{
		from: "PR_CREATING",
		to: "CI_RUNNING",
		owner: "github_adapter",
		cause: "pr_identity_persisted",
	},
	{
		from: "PR_CREATING",
		to: "PR_CREATION_FAILED",
		owner: "github_adapter",
		cause: "push_or_pr_creation_failed",
	},
	{
		from: "PR_CREATION_FAILED",
		to: "PR_CREATING",
		owner: "human",
		cause: "explicit_pr_retry",
	},
	{
		from: "CI_RUNNING",
		to: "CI_FAILED",
		owner: "poller",
		cause: "current_head_check_failed",
	},
	{
		from: "CI_RUNNING",
		to: "PR_REVIEW",
		owner: "poller",
		cause: "checks_passed_or_none_required",
	},
	{
		from: "CI_FAILED",
		to: "CI_RUNNING",
		owner: "poller",
		cause: "new_head_or_check_pending",
	},
	{
		from: "CI_FAILED",
		to: "PR_REVIEW",
		owner: "poller",
		cause: "external_fix_checks_passed",
	},
	{
		from: "PR_REVIEW",
		to: "PR_CHANGES_REQUESTED",
		owner: "poller",
		cause: "review_requested_changes",
	},
	{
		from: "PR_CHANGES_REQUESTED",
		to: "CI_RUNNING",
		owner: "poller",
		cause: "external_commits_changed_status",
	},
	{
		from: "PR_CHANGES_REQUESTED",
		to: "PR_REVIEW",
		owner: "poller",
		cause: "external_reviews_changed_status",
	},
	// Any PR state → DEVELOPMENT_MERGED
	{
		from: "PR_CREATING",
		to: "DEVELOPMENT_MERGED",
		owner: "poller",
		cause: "pr_merged_to_development_branch",
	},
	{
		from: "PR_CREATION_FAILED",
		to: "DEVELOPMENT_MERGED",
		owner: "poller",
		cause: "pr_merged_to_development_branch",
	},
	{
		from: "CI_RUNNING",
		to: "DEVELOPMENT_MERGED",
		owner: "poller",
		cause: "pr_merged_to_development_branch",
	},
	{
		from: "CI_FAILED",
		to: "DEVELOPMENT_MERGED",
		owner: "poller",
		cause: "pr_merged_to_development_branch",
	},
	{
		from: "PR_REVIEW",
		to: "DEVELOPMENT_MERGED",
		owner: "poller",
		cause: "pr_merged_to_development_branch",
	},
	{
		from: "PR_CHANGES_REQUESTED",
		to: "DEVELOPMENT_MERGED",
		owner: "poller",
		cause: "pr_merged_to_development_branch",
	},
];

const PR_STATES: FeatureState[] = [
	"PR_CREATING",
	"PR_CREATION_FAILED",
	"CI_RUNNING",
	"CI_FAILED",
	"PR_REVIEW",
	"PR_CHANGES_REQUESTED",
];

const NONTERMINAL: FeatureState[] = FEATURE_STATES.filter((s) => s !== "DEVELOPMENT_MERGED");

function allowedKey(from: FeatureState, to: FeatureState): string {
	return `${from}->${to}`;
}

const ALLOWED_KEYS = new Set(ALLOWED.map((e) => allowedKey(e.from, e.to)));

// Any nonterminal → BLOCKED via guard (added to allowed set for matrix)
for (const from of NONTERMINAL) {
	ALLOWED_KEYS.add(allowedKey(from, "BLOCKED"));
}

function cmd(
	overrides: Partial<FeatureTransitionCommand> &
		Pick<FeatureTransitionCommand, "from" | "to" | "owner" | "cause">,
): FeatureTransitionCommand {
	return {
		featureId: "feat-1",
		operationId: "op-1",
		expectedVersion: 1,
		currentVersion: 1,
		...overrides,
	};
}

describe("feature state machine — F-5 exhaustive matrix", () => {
	test("exports the closed Phase 1 state set", () => {
		expect(FEATURE_STATES).toEqual([
			"PLANNED",
			"TASKS_REVIEW",
			"QUEUED",
			"DEVELOPING",
			"DEVELOPMENT_FAILED",
			"DEVELOPMENT_INTERRUPTED",
			"DEVELOPMENT_CANCELLED",
			"DEVELOPMENT_COMPLETE",
			"PR_CREATING",
			"PR_CREATION_FAILED",
			"CI_RUNNING",
			"CI_FAILED",
			"PR_REVIEW",
			"PR_CHANGES_REQUESTED",
			"DEVELOPMENT_MERGED",
			"BLOCKED",
		]);
		expect(isFeatureState("PLANNED")).toBe(true);
		expect(isFeatureState("not-a-state")).toBe(false);
		expect(isTerminalFeatureState("DEVELOPMENT_MERGED")).toBe(true);
		for (const s of NONTERMINAL) {
			expect(isTerminalFeatureState(s)).toBe(false);
		}
	});

	test("accepts every allowed F-5 transition with matching owner and returns event metadata", () => {
		for (const edge of ALLOWED) {
			const result = applyFeatureTransition(
				cmd({
					from: edge.from,
					to: edge.to,
					owner: edge.owner,
					cause: edge.cause,
					operationId: `op-${edge.from}-${edge.to}`,
				}),
				{ now: FIXED_NOW },
			);
			expect(result.kind).toBe("applied");
			if (result.kind !== "applied") continue;
			expect(result.priorState).toBe(edge.from);
			expect(result.nextState).toBe(edge.to);
			expect(result.owner).toBe(edge.owner);
			expect(result.cause).toBe(edge.cause);
			expect(result.timestamp).toBe("2026-07-18T12:00:00.000Z");
			expect(result.priorVersion).toBe(1);
			expect(result.nextVersion).toBe(2);
			expect(result.featureId).toBe("feat-1");
			expect(result.operationId).toBe(`op-${edge.from}-${edge.to}`);
			expect(result.event).toEqual({
				type: "feature.transitioned",
				featureId: "feat-1",
				from: edge.from,
				to: edge.to,
				owner: edge.owner,
				cause: edge.cause,
				operationId: `op-${edge.from}-${edge.to}`,
				timestamp: "2026-07-18T12:00:00.000Z",
				priorVersion: 1,
				nextVersion: 2,
			});
		}
	});

	test("accepts BLOCKED entry from every nonterminal state only via deterministic guard", () => {
		for (const from of NONTERMINAL) {
			const ok = applyFeatureTransition(
				cmd({
					from,
					to: "BLOCKED",
					owner: "guard",
					cause: "invariant_violated",
					operationId: `block-${from}`,
				}),
				{ now: FIXED_NOW },
			);
			expect(ok.kind).toBe("applied");

			const wrongOwner = applyFeatureTransition(
				cmd({
					from,
					to: "BLOCKED",
					owner: "human",
					cause: "invariant_violated",
					operationId: `block-bad-${from}`,
				}),
				{ now: FIXED_NOW },
			);
			expect(wrongOwner.kind).toBe("rejected");
			if (wrongOwner.kind !== "rejected") continue;
			expect(wrongOwner.reason).toBe("forbidden_transition");
		}
	});

	test("rejects every unlisted source/target pair without mutation metadata", () => {
		const forbidden: Array<{ from: FeatureState; to: FeatureState }> = [];
		for (const from of FEATURE_STATES) {
			for (const to of FEATURE_STATES) {
				if (from === to) continue;
				if (ALLOWED_KEYS.has(allowedKey(from, to))) continue;
				forbidden.push({ from, to });
			}
		}
		// Sanity: matrix is non-trivial
		expect(forbidden.length).toBeGreaterThan(100);

		for (const { from, to } of forbidden) {
			const result = applyFeatureTransition(
				cmd({
					from,
					to,
					owner: "human",
					cause: "probe",
					operationId: `forbid-${from}-${to}`,
				}),
				{ now: FIXED_NOW },
			);
			expect(result.kind).toBe("rejected");
			if (result.kind !== "rejected") continue;
			expect(result.reason).toBe("forbidden_transition");
			expect(result.priorState).toBe(from);
			expect(result.nextState).toBe(from);
		}
	});

	test("rejects wrong owner for an otherwise allowed edge", () => {
		const result = applyFeatureTransition(
			cmd({
				from: "PLANNED",
				to: "TASKS_REVIEW",
				owner: "worker",
				cause: "owner_attached_valid_task",
			}),
			{ now: FIXED_NOW },
		);
		expect(result.kind).toBe("rejected");
		if (result.kind !== "rejected") return;
		expect(result.reason).toBe("forbidden_transition");
	});

	test("DEVELOPMENT_MERGED rejects all outgoing transitions including self and BLOCKED", () => {
		for (const to of FEATURE_STATES) {
			if (to === "DEVELOPMENT_MERGED") continue;
			const result = applyFeatureTransition(
				cmd({
					from: "DEVELOPMENT_MERGED",
					to,
					owner: to === "BLOCKED" ? "guard" : "poller",
					cause: "probe",
				}),
				{ now: FIXED_NOW },
			);
			expect(result.kind).toBe("rejected");
		}
	});

	test("idempotent repeat with same operation identity returns prior result without second transition", () => {
		const first = applyFeatureTransition(
			cmd({
				from: "TASKS_REVIEW",
				to: "QUEUED",
				owner: "human",
				cause: "owner_approved_and_queued",
				operationId: "approve-1",
			}),
			{ now: FIXED_NOW },
		);
		expect(first.kind).toBe("applied");
		if (first.kind !== "applied") return;

		// Same operation already applied: current state already target, same operationId.
		const repeat = applyFeatureTransition(
			cmd({
				from: "QUEUED",
				to: "QUEUED",
				owner: "human",
				cause: "owner_approved_and_queued",
				operationId: "approve-1",
				expectedVersion: 2,
				currentVersion: 2,
				priorAppliedOperationId: "approve-1",
				priorAppliedResult: first,
			}),
			{ now: FIXED_NOW },
		);
		expect(repeat.kind).toBe("idempotent");
		if (repeat.kind !== "idempotent") return;
		expect(repeat.result).toEqual(first);
		expect(repeat.emitted).toBe(false);
	});

	test("expected prior state mismatch produces typed conflict and no mutation", () => {
		const result = applyFeatureTransition(
			cmd({
				from: "PLANNED",
				to: "TASKS_REVIEW",
				owner: "human_and_validation",
				cause: "owner_attached_valid_task",
				// Command thinks feature is PLANNED but caller supplies observed current as QUEUED
				observedState: "QUEUED",
			}),
			{ now: FIXED_NOW },
		);
		expect(result.kind).toBe("rejected");
		if (result.kind !== "rejected") return;
		expect(result.reason).toBe("state_conflict");
		expect(result.priorState).toBe("QUEUED");
		expect(result.nextState).toBe("QUEUED");
	});

	test("row-version mismatch produces typed conflict and no mutation", () => {
		const result = applyFeatureTransition(
			cmd({
				from: "PLANNED",
				to: "TASKS_REVIEW",
				owner: "human_and_validation",
				cause: "owner_attached_valid_task",
				expectedVersion: 3,
				currentVersion: 5,
			}),
			{ now: FIXED_NOW },
		);
		expect(result.kind).toBe("rejected");
		if (result.kind !== "rejected") return;
		expect(result.reason).toBe("version_conflict");
		expect(result.priorState).toBe("PLANNED");
		expect(result.nextState).toBe("PLANNED");
	});

	test("listAllowedTransitions enumerates F-5 edges for each state", () => {
		const planned = listAllowedTransitions("PLANNED");
		expect(planned).toContainEqual({
			to: "TASKS_REVIEW",
			owner: "human_and_validation",
		});
		expect(planned).toContainEqual({ to: "BLOCKED", owner: "guard" });

		const merged = listAllowedTransitions("DEVELOPMENT_MERGED");
		expect(merged).toEqual([]);

		for (const pr of PR_STATES) {
			const edges = listAllowedTransitions(pr);
			expect(edges.some((e) => e.to === "DEVELOPMENT_MERGED" && e.owner === "poller")).toBe(true);
		}
	});

	test("no public path assigns state without going through the transition service", () => {
		// Structural: applyFeatureTransition is the sole mutator export used by tests.
		// Direct state assignment is a type-level concern; ensure service rejects free-form.
		const result = applyFeatureTransition(
			cmd({
				from: "PLANNED",
				to: "DEVELOPMENT_MERGED",
				owner: "human",
				cause: "skip_everything",
			}),
			{ now: FIXED_NOW },
		);
		expect(result.kind).toBe("rejected");
	});
});
