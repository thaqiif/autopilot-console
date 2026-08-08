/**
 * @autopilot-console/github
 * Typed GitHubGateway and gh CLI adapter (no approve/merge).
 */

export const packageName = "@autopilot-console/github" as const;

export type { GhCliGatewayOptions, GhRunner, GhRunResult } from "./gh-cli-gateway";

export { GhCliGateway } from "./gh-cli-gateway";
export type {
	CheckConclusion,
	CheckObservation,
	CreatePullRequestRequest,
	FindPullRequestRequest,
	GetPullRequestStatusRequest,
	GitHubGateway,
	PullRequestIdentity,
	PullRequestLifecycleState,
	PullRequestStatus,
	RepositoryRef,
	ReviewDecision,
	ValidateAccessRequest,
	ValidateAccessResult,
	ValidateAuthenticationResult,
} from "./github-gateway";
