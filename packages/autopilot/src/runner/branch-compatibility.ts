/**
 * Non-destructive strategy reconciling task-basename checkout with
 * Console's deterministic feature/<feature-id>-<slug> branch.
 */

import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export interface BranchCompatibilityPlan {
	taskBasename: string;
	expectedBranch: string;
	/** Always empty for the supported strategy (no destructive ops). */
	destructiveOperations: string[];
}

export interface BranchCompatibilityCheck {
	ok: boolean;
	strategy: string;
	canFastForwardExpected?: boolean;
	message?: string;
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return {
		status: r.status ?? 1,
		stdout: (r.stdout || "").trim(),
		stderr: (r.stderr || "").trim(),
	};
}

function taskBasenameFromRelative(taskRelativePath: string): string {
	const base = basename(taskRelativePath);
	return base.endsWith(".json") ? base.slice(0, -5) : base;
}

export async function prepareBranchCompatibility(input: {
	projectRoot: string;
	taskRelativePath: string;
	expectedBranch: string;
}): Promise<BranchCompatibilityPlan> {
	const taskBasename = taskBasenameFromRelative(input.taskRelativePath);
	if (!taskBasename || taskBasename.includes("..") || taskBasename.includes("/")) {
		throw new Error("invalid task basename for branch compatibility");
	}
	if (!input.expectedBranch.startsWith("feature/")) {
		throw new Error("expectedBranch must be feature/<id>-<slug>");
	}

	const expectedRef = git(input.projectRoot, ["rev-parse", "--verify", input.expectedBranch]);
	if (expectedRef.status !== 0) {
		throw new Error(`expected branch missing: ${input.expectedBranch}`);
	}

	// Point basename at the same tip as expected (create or force-update local ref only).
	// `git branch -f` updates a local branch pointer; it does not delete history or remote refs.
	const existing = git(input.projectRoot, ["rev-parse", "--verify", taskBasename]);
	if (existing.status === 0) {
		const upd = git(input.projectRoot, ["branch", "-f", taskBasename, input.expectedBranch]);
		if (upd.status !== 0) {
			throw new Error(`failed to align basename branch: ${upd.stderr}`);
		}
	} else {
		const created = git(input.projectRoot, ["branch", taskBasename, input.expectedBranch]);
		if (created.status !== 0) {
			throw new Error(`failed to create basename branch: ${created.stderr}`);
		}
	}

	return {
		taskBasename,
		expectedBranch: input.expectedBranch,
		destructiveOperations: [],
	};
}

export async function assertBranchCompatibility(input: {
	projectRoot: string;
	expectedBranch: string;
	taskBasename: string;
}): Promise<BranchCompatibilityCheck> {
	const strategy = "basename co-tip + ff-only reconcile; destructive ops forbidden";

	const expected = git(input.projectRoot, ["rev-parse", "--verify", input.expectedBranch]);
	if (expected.status !== 0) {
		return {
			ok: false,
			strategy,
			message: "expected feature branch missing",
		};
	}

	const head = git(input.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const headName = head.stdout;
	const headSha = git(input.projectRoot, ["rev-parse", "HEAD"]).stdout;

	// Basename tip if present.
	const baseRef = git(input.projectRoot, ["rev-parse", "--verify", input.taskBasename]);
	const expectedSha = expected.stdout;

	// HEAD must be on expected or basename for a reconcilable post-run state.
	if (headName !== input.expectedBranch && headName !== input.taskBasename) {
		return {
			ok: false,
			strategy,
			canFastForwardExpected: false,
			message: "HEAD is on an unrelated branch; cannot reconcile without rewrite",
		};
	}

	// If HEAD is expected at known tip → ok (possibly still need basename ff later).
	if (headName === input.expectedBranch) {
		if (baseRef.status === 0) {
			const baseSha = baseRef.stdout;
			if (baseSha === expectedSha) {
				return { ok: true, strategy, canFastForwardExpected: true };
			}
			const isAncestor = git(input.projectRoot, [
				"merge-base",
				"--is-ancestor",
				expectedSha,
				baseSha,
			]);
			if (isAncestor.status === 0) {
				return { ok: true, strategy, canFastForwardExpected: true };
			}
			return {
				ok: false,
				strategy,
				canFastForwardExpected: false,
				message: "basename tip is not a fast-forward of expected branch",
			};
		}
		return { ok: true, strategy, canFastForwardExpected: true };
	}

	// HEAD is on basename.
	if (baseRef.status !== 0) {
		return {
			ok: false,
			strategy,
			canFastForwardExpected: false,
			message: "task basename branch missing after run",
		};
	}
	const baseSha = baseRef.stdout;
	if (baseSha === expectedSha || headSha === expectedSha) {
		return { ok: true, strategy, canFastForwardExpected: true };
	}
	const isAncestor = git(input.projectRoot, ["merge-base", "--is-ancestor", expectedSha, baseSha]);
	if (isAncestor.status === 0) {
		return { ok: true, strategy, canFastForwardExpected: true };
	}

	return {
		ok: false,
		strategy,
		canFastForwardExpected: false,
		message: "basename tip is not a fast-forward of expected branch",
	};
}
