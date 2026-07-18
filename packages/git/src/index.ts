/**
 * @autopilot-console/git
 * Constrained GitGateway: preflight, feature branch create/reuse, commit observation, safe push.
 */

export const packageName = "@autopilot-console/git" as const;

export { CliGitGateway } from "./cli-git-gateway";
export type {
	CommitObservation,
	EnsureFeatureBranchRequest,
	EnsureFeatureBranchResult,
	GitGateway,
	GitPreflightFailureCode,
	GitPreflightRequest,
	GitPreflightResult,
	ObserveCommitsRequest,
	RepositoryIdentityView,
	SafePushRequest,
	SafePushResult,
} from "./git-gateway";
