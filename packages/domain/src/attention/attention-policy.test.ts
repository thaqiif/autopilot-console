import { describe, expect, test } from "bun:test";
import { FEATURE_STATES, type FeatureState } from "../feature/feature-state";
import {
	type ATTENTION_ACTIONS,
	type ATTENTION_CATEGORIES,
	type AttentionInput,
	deriveAttention,
	deriveAttentionForFeatures,
} from "./attention-policy";

const BASE = {
	projectId: "proj-1",
	releaseId: "rel-1",
	featureId: "feat-1",
	stateChangedAt: "2026-07-18T00:00:00.000Z",
} as const;

function input(state: FeatureState, extra: Partial<AttentionInput> = {}): AttentionInput {
	return {
		...BASE,
		state,
		...extra,
	};
}

const ATTENTION_STATES: ReadonlyArray<{
	state: FeatureState;
	category: (typeof ATTENTION_CATEGORIES)[number];
	action: (typeof ATTENTION_ACTIONS)[number];
}> = [
	{ state: "TASKS_REVIEW", category: "task_review", action: "review_tasks" },
	{
		state: "DEVELOPMENT_FAILED",
		category: "development_failed",
		action: "retry_development",
	},
	{
		state: "DEVELOPMENT_INTERRUPTED",
		category: "development_interrupted",
		action: "retry_development",
	},
	{
		state: "PR_CREATION_FAILED",
		category: "pr_creation_failed",
		action: "retry_pr_creation",
	},
	{ state: "CI_FAILED", category: "ci_failed", action: "open_github_checks" },
	{ state: "PR_REVIEW", category: "pr_review", action: "open_github_pr" },
	{
		state: "PR_CHANGES_REQUESTED",
		category: "pr_changes_requested",
		action: "open_github_pr",
	},
	{ state: "BLOCKED", category: "blocked", action: "resolve_block" },
];

const NON_ATTENTION_STATES: FeatureState[] = [
	"PLANNED",
	"QUEUED",
	"DEVELOPING",
	"DEVELOPMENT_CANCELLED",
	"DEVELOPMENT_COMPLETE",
	"PR_CREATING",
	"CI_RUNNING",
	"DEVELOPMENT_MERGED",
];

describe("deriveAttention", () => {
	test("produces attention for every Phase 1 attention state", () => {
		for (const row of ATTENTION_STATES) {
			const item = deriveAttention(input(row.state));
			expect(item).not.toBeNull();
			if (!item) throw new Error("expected attention");
			expect(item.projectId).toBe(BASE.projectId);
			expect(item.releaseId).toBe(BASE.releaseId);
			expect(item.featureId).toBe(BASE.featureId);
			expect(item.currentState).toBe(row.state);
			expect(item.category).toBe(row.category);
			expect(item.primaryAction).toBe(row.action);
			expect(item.reason).toBe(row.category);
			expect(item.ageBasis).toBe(BASE.stateChangedAt);
			// Exactly one primary action field
			expect(Object.keys(item).filter((k) => k === "primaryAction")).toHaveLength(1);
		}
	});

	test("healthy waiting, planned, queued, running, cancelled, complete, merged produce no attention", () => {
		for (const state of NON_ATTENTION_STATES) {
			expect(deriveAttention(input(state))).toBeNull();
		}
	});

	test("matrix covers every FeatureState exactly once across attention and non-attention", () => {
		const covered = new Set([...ATTENTION_STATES.map((r) => r.state), ...NON_ATTENTION_STATES]);
		expect([...covered].sort()).toEqual([...FEATURE_STATES].sort());
	});

	test("optional releaseId may be omitted", () => {
		const item = deriveAttention({
			projectId: "p",
			featureId: "f",
			state: "TASKS_REVIEW",
			stateChangedAt: "2026-07-18T01:00:00.000Z",
		});
		expect(item?.releaseId).toBeUndefined();
		expect(item?.projectId).toBe("p");
	});

	test("stale GitHub sync produces attention even when state is healthy", () => {
		const item = deriveAttention(
			input("CI_RUNNING", {
				staleGithubSync: true,
				staleSince: "2026-07-18T02:00:00.000Z",
			}),
		);
		expect(item).not.toBeNull();
		expect(item?.category).toBe("stale_github_sync");
		expect(item?.reason).toBe("stale_github_sync");
		expect(item?.primaryAction).toBe("refresh_github_status");
		expect(item?.currentState).toBe("CI_RUNNING");
		expect(item?.ageBasis).toBe("2026-07-18T02:00:00.000Z");
	});

	test("stale GitHub sync falls back to the state-change time when staleSince is absent", () => {
		const item = deriveAttention(input("CI_RUNNING", { staleGithubSync: true }));

		expect(item?.ageBasis).toBe(BASE.stateChangedAt);
		expect(item?.releaseId).toBe(BASE.releaseId);
	});

	test("lifecycle attention wins over stale flag when both apply", () => {
		const item = deriveAttention(
			input("CI_FAILED", {
				staleGithubSync: true,
				staleSince: "2026-07-18T03:00:00.000Z",
			}),
		);
		expect(item?.category).toBe("ci_failed");
		expect(item?.primaryAction).toBe("open_github_checks");
		expect(item?.ageBasis).toBe(BASE.stateChangedAt);
	});

	test("stale flag on DEVELOPMENT_MERGED still surfaces stale-sync attention", () => {
		const item = deriveAttention(
			input("DEVELOPMENT_MERGED", {
				staleGithubSync: true,
				staleSince: "2026-07-18T04:00:00.000Z",
			}),
		);
		expect(item?.category).toBe("stale_github_sync");
	});

	test("deriveAttentionForFeatures returns only attention items in input order", () => {
		const items = deriveAttentionForFeatures([
			input("PLANNED", { featureId: "a" }),
			input("TASKS_REVIEW", { featureId: "b" }),
			input("QUEUED", { featureId: "c" }),
			input("BLOCKED", { featureId: "d" }),
		]);
		expect(items.map((i) => i.featureId)).toEqual(["b", "d"]);
	});

	test("attention projections never embed raw credential-bearing text", () => {
		const item = deriveAttention(input("BLOCKED"));
		const blob = JSON.stringify(item);
		expect(blob).not.toMatch(/ghp_/);
		expect(blob).not.toMatch(/Bearer\s+\w/i);
		expect(blob).not.toMatch(/password\s*=/i);
	});
});
