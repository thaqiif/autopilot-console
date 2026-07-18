import { describe, expect, test } from "bun:test";
import {
	FAILURE_KINDS,
	type FailureKind,
	mapFailure,
	type MapFailureInput,
} from "./failure-policy";

describe("mapFailure", () => {
	const cases: Array<{
		kind: FailureKind;
		summaryIncludes: string;
		action: string;
		attentionCategory: string | null;
	}> = [
		{
			kind: "validation",
			summaryIncludes: "validation",
			action: "fix_input",
			attentionCategory: "blocked",
		},
		{
			kind: "queue",
			summaryIncludes: "queue",
			action: "retry_development",
			attentionCategory: "development_failed",
		},
		{
			kind: "process",
			summaryIncludes: "process",
			action: "retry_development",
			attentionCategory: "development_failed",
		},
		{
			kind: "task_result",
			summaryIncludes: "task",
			action: "retry_development",
			attentionCategory: "development_failed",
		},
		{
			kind: "git",
			summaryIncludes: "git",
			action: "resolve_block",
			attentionCategory: "blocked",
		},
		{
			kind: "github",
			summaryIncludes: "github",
			action: "retry_pr_creation",
			attentionCategory: "pr_creation_failed",
		},
		{
			kind: "ci",
			summaryIncludes: "ci",
			action: "open_github_checks",
			attentionCategory: "ci_failed",
		},
		{
			kind: "cancellation",
			summaryIncludes: "cancel",
			action: "retry_development",
			attentionCategory: null,
		},
		{
			kind: "interruption",
			summaryIncludes: "interrupt",
			action: "retry_development",
			attentionCategory: "development_interrupted",
		},
		{
			kind: "stale_sync",
			summaryIncludes: "sync",
			action: "refresh_github_status",
			attentionCategory: "stale_github_sync",
		},
	];

	test("maps every failure kind to safe summary and recommended next action", () => {
		expect(FAILURE_KINDS.length).toBe(cases.length);
		for (const row of cases) {
			const result = mapFailure({ kind: row.kind });
			expect(result.kind).toBe(row.kind);
			expect(result.summary.toLowerCase()).toContain(row.summaryIncludes);
			expect(result.recommendedAction).toBe(row.action);
			expect(result.attentionCategory).toBe(row.attentionCategory);
			expect(result.requiresExplicitRetry).toBe(
				row.kind === "process" ||
					row.kind === "task_result" ||
					row.kind === "interruption" ||
					row.kind === "github" ||
					row.kind === "queue" ||
					row.kind === "git",
			);
		}
	});

	test("redacts credential-bearing diagnostic detail", () => {
		const input: MapFailureInput = {
			kind: "github",
			detail:
				"gh auth failed Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789 password=supersecret https://user:pass@github.com/org/repo.git",
		};
		const result = mapFailure(input);
		expect(result.summary).not.toMatch(/ghp_/);
		expect(result.summary).not.toMatch(/supersecret/);
		expect(result.summary).not.toMatch(/Bearer\s+ghp/i);
		expect(result.summary).not.toMatch(/user:pass@/);
		expect(result.detail).not.toMatch(/ghp_/);
		expect(result.detail).not.toMatch(/supersecret/);
		expect(result.detail).not.toMatch(/user:pass@/);
		expect(result.detail).toContain("[REDACTED]");
	});

	test("omits detail when not provided", () => {
		const result = mapFailure({ kind: "ci" });
		expect(result.detail).toBeUndefined();
	});

	test("cancellation does not force attention category", () => {
		const result = mapFailure({ kind: "cancellation" });
		expect(result.attentionCategory).toBeNull();
		expect(result.requiresExplicitRetry).toBe(false);
	});

	test("ci failures keep polling recommendation without agent repair wording", () => {
		const result = mapFailure({ kind: "ci" });
		const blob = `${result.summary} ${result.recommendedAction}`.toLowerCase();
		expect(blob).not.toContain("repair agent");
		expect(blob).not.toContain("auto-fix");
		expect(result.recommendedAction).toBe("open_github_checks");
	});
});
