import type {
	GitHubGateway,
	PullRequestStatus,
	RepositoryRef,
} from "../../../../packages/github/src/index";

export interface PollablePRView {
	featureId: string;
	projectId: string;
	prNumber: number;
	url: string;
	headBranch: string;
	baseBranch: string;
	originalHeadSha: string;
	observedHeadSha: string | null;
	observedState: string | null;
	featureState: string;
	lastObservedAt: Date | null;
}

export interface PRReconciliationStore {
	listOpenPRs(): Promise<PollablePRView[]>;
	updatePRObservation(
		featureId: string,
		input: { observedHeadSha: string; observedState: string | null; lastObservedAt: Date },
	): Promise<void>;
	transitionFeature(
		featureId: string,
		input: { from: string; to: string; owner: string; operationId: string },
	): Promise<{ kind: "applied" } | { kind: "rejected"; reason: string }>;
	recordActivity(input: {
		projectId: string;
		featureId?: string;
		type: string;
		summary: string;
		metadata?: unknown;
	}): Promise<void>;
	recordAudit(input: {
		projectId: string;
		actor: string;
		action: string;
		target: string;
	}): Promise<void>;
	recordBackoff(featureId: string, error: string): Promise<void>;
	shouldBackoff(featureId: string): Promise<boolean>;
}

export interface PRReconciliationWorker {
	pollAll(): Promise<number>;
}

export interface PRReconciliationWorkerOptions {
	store: PRReconciliationStore;
	github: GitHubGateway;
	repository: RepositoryRef;
	now?: () => Date;
	maxConsecutiveErrors?: number;
}

interface ResolvedCheckState {
	targetState: string;
	activityType: string | null;
}

function resolveCheckState(status: PullRequestStatus): ResolvedCheckState {
	if (status.state === "merged") {
		return { targetState: "DEVELOPMENT_MERGED", activityType: "pr.merged" };
	}
	if (status.state === "closed") {
		return { targetState: "BLOCKED", activityType: "pr.closed_without_merge" };
	}

	if (status.checkSummary === "pending") {
		return { targetState: "CI_RUNNING", activityType: null };
	}
	if (status.checkSummary === "failing") {
		return { targetState: "CI_FAILED", activityType: "ci.failed" };
	}

	if (status.reviewDecision === "CHANGES_REQUESTED") {
		return { targetState: "PR_CHANGES_REQUESTED", activityType: "pr.changes_requested" };
	}

	return {
		targetState: "PR_REVIEW",
		activityType: status.checkSummary === "passing" ? "ci.passed" : null,
	};
}

const TERMINAL_STATES = new Set(["DEVELOPMENT_MERGED", "BLOCKED"]);

const RECONCILIABLE_STATES = new Set([
	"CI_RUNNING",
	"CI_FAILED",
	"PR_REVIEW",
	"PR_CHANGES_REQUESTED",
	"PR_CREATING",
	"PR_CREATION_FAILED",
]);

export function createPRReconciliationWorker(
	options: PRReconciliationWorkerOptions,
): PRReconciliationWorker {
	const { store, github, repository, now = () => new Date(), maxConsecutiveErrors = 5 } = options;

	// Per-feature consecutive error tracking
	const consecutiveErrors = new Map<string, number>();

	return {
		async pollAll(): Promise<number> {
			const prs = await store.listOpenPRs();
			let polled = 0;

			for (const pr of prs) {
				if (TERMINAL_STATES.has(pr.featureState)) continue;
				if (!RECONCILIABLE_STATES.has(pr.featureState)) continue;

				const shouldSkip = await store.shouldBackoff(pr.featureId);
				if (shouldSkip) continue;

				try {
					const status = await github.getPullRequestStatus({
						repository,
						number: pr.prNumber,
					});

					// Reset error count on success
					consecutiveErrors.set(pr.featureId, 0);

					const observationTime = now();

					// Stale observation protection
					if (pr.lastObservedAt && observationTime <= pr.lastObservedAt) {
						polled++;
						continue;
					}

					await store.updatePRObservation(pr.featureId, {
						observedHeadSha: status.currentHeadSha,
						observedState: status.state,
						lastObservedAt: observationTime,
					});

					const { targetState, activityType } = resolveCheckState(status);

					if (targetState !== pr.featureState) {
						const operationId = `reconcile:${pr.featureId}:${targetState}:${observationTime.toISOString()}`;
						const transition = await store.transitionFeature(pr.featureId, {
							from: pr.featureState,
							to: targetState,
							owner: "poller",
							operationId,
						});

						if (transition.kind === "applied" && activityType) {
							await store.recordActivity({
								projectId: pr.projectId,
								featureId: pr.featureId,
								type: activityType,
								summary: `State changed to ${targetState}`,
								metadata: {
									headSha: status.currentHeadSha,
									checkSummary: status.checkSummary,
									reviewDecision: status.reviewDecision,
									lifecycleState: status.state,
								},
							});

							await store.recordAudit({
								projectId: pr.projectId,
								actor: "github_poller",
								action: activityType,
								target: pr.featureId,
							});
						}
					}

					polled++;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "unknown";
					const count = (consecutiveErrors.get(pr.featureId) ?? 0) + 1;
					consecutiveErrors.set(pr.featureId, count);

					await store.recordBackoff(pr.featureId, errorMessage);

					if (count >= maxConsecutiveErrors) {
						await store.recordActivity({
							projectId: pr.projectId,
							featureId: pr.featureId,
							type: "pr.stale_sync",
							summary: `Repeated poll failures detected: ${errorMessage}`,
						});
					}

					polled++;
				}
			}

			return polled;
		},
	};
}
