/**
 * CLI implementation of GitGateway — fixed subcommands only, shell disabled.
 */

import { ensureFeatureBranch } from "./branch-workflow";
import { observeCommits } from "./commit-observer";
import type {
	CommitObservation,
	EnsureFeatureBranchRequest,
	EnsureFeatureBranchResult,
	GitGateway,
	GitPreflightRequest,
	GitPreflightResult,
	ObserveCommitsRequest,
	SafePushRequest,
	SafePushResult,
} from "./git-gateway";
import { runPreflight } from "./preflight";
import { pushFeatureBranch } from "./safe-push";

export class CliGitGateway implements GitGateway {
	preflight(request: GitPreflightRequest): Promise<GitPreflightResult> {
		return runPreflight(request);
	}

	ensureFeatureBranch(request: EnsureFeatureBranchRequest): Promise<EnsureFeatureBranchResult> {
		return ensureFeatureBranch(request);
	}

	observeCommits(request: ObserveCommitsRequest): Promise<CommitObservation[]> {
		return observeCommits(request);
	}

	pushFeatureBranch(request: SafePushRequest): Promise<SafePushResult> {
		return pushFeatureBranch(request);
	}
}
