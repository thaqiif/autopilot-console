/**
 * Non-destructive strategy reconciling task-basename checkout with
 * Console's deterministic feature/<feature-id>-<slug> branch.
 */

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

export async function prepareBranchCompatibility(_input: {
	projectRoot: string;
	taskRelativePath: string;
	expectedBranch: string;
}): Promise<BranchCompatibilityPlan> {
	throw new Error("not implemented: prepareBranchCompatibility");
}

export async function assertBranchCompatibility(_input: {
	projectRoot: string;
	expectedBranch: string;
	taskBasename: string;
}): Promise<BranchCompatibilityCheck> {
	throw new Error("not implemented: assertBranchCompatibility");
}
