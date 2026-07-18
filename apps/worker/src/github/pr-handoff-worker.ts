import type { GitGateway } from "../../../../packages/git/src/index";
import type { GitHubGateway } from "../../../../packages/github/src/index";

export interface PRHandoffContext {
	attempt: {
		id: string;
		projectId: string;
		featureId: string;
		branchName: string;
		taskApprovalId: string;
	};
	project: {
		id: string;
		githubOwner: string;
		githubRepo: string;
		canonicalPath: string;
		developmentBranch: string;
	};
	feature: {
		id: string;
		projectId: string;
		state: string;
		branchName: string;
		slug: string;
		title: string;
		rowVersion: number;
	};
	approval: {
		id: string;
		checksum: string;
	};
}

export interface PRHandoffStore {
	loadHandoffContext(attemptId: string): Promise<PRHandoffContext | null>;
	getExistingPRByFeature(featureId: string): Promise<{
		id: string;
		number: number;
		url: string;
		headBranch: string;
		baseBranch: string;
		originalHeadSha: string;
	} | null>;
	persistPRIdentity(
		featureId: string,
		input: {
			projectId: string;
			repositoryOwner: string;
			repositoryName: string;
			number: number;
			url: string;
			headBranch: string;
			baseBranch: string;
			originalHeadSha: string;
		},
	): Promise<{
		id: string;
		number: number;
		url: string;
		headBranch: string;
		baseBranch: string;
		originalHeadSha: string;
	}>;
	transitionFeature(
		featureId: string,
		input: { from: string; to: string; owner: string; operationId: string },
	): Promise<{ kind: "applied" } | { kind: "rejected"; reason: string }>;
	recordActivity(input: {
		projectId: string;
		featureId?: string;
		attemptId?: string;
		type: string;
		summary: string;
		metadata?: unknown;
	}): Promise<void>;
	recordAudit(input: {
		projectId: string;
		actor: string;
		action: string;
		target: string;
		prior?: unknown;
		next?: unknown;
	}): Promise<void>;
	createOutboxIntent(input: {
		projectId: string;
		featureId?: string;
		kind: string;
		dedupeKey: string;
		payload?: unknown;
	}): Promise<void>;
	persistFailure(input: {
		featureId: string;
		targetState: string;
		reason: string;
		activityType: string;
	}): Promise<void>;
	checkIdempotency(operationKey: string): Promise<unknown | null>;
	recordIdempotency(operationKey: string, result: unknown): Promise<void>;
}

export type PRHandoffOutcome =
	| { kind: "completed"; prNumber?: number }
	| { kind: "failed"; reason: string }
	| { kind: "idle" };

export interface PRHandoffWorker {
	handoff(attemptId: string): Promise<PRHandoffOutcome>;
}

export interface PRHandoffWorkerOptions {
	store: PRHandoffStore;
	git: GitGateway;
	github: GitHubGateway;
	workerId: string;
	remoteName?: string;
	now?: () => Date;
}

export function createPRHandoffWorker(options: PRHandoffWorkerOptions): PRHandoffWorker {
	const { store, git, github, workerId, remoteName = "origin", now = () => new Date() } = options;

	return {
		async handoff(attemptId: string): Promise<PRHandoffOutcome> {
			const idempotencyKey = `pr-handoff:${attemptId}`;
			const existing = await store.checkIdempotency(idempotencyKey);
			if (existing) {
				return existing as PRHandoffOutcome;
			}

			const ctx = await store.loadHandoffContext(attemptId);
			if (!ctx) return { kind: "idle" };

			if (ctx.feature.state !== "DEVELOPMENT_COMPLETE" && ctx.feature.state !== "PR_CREATING") {
				return { kind: "idle" };
			}

			// Transition DEVELOPMENT_COMPLETE -> PR_CREATING if needed
			if (ctx.feature.state === "DEVELOPMENT_COMPLETE") {
				const transition = await store.transitionFeature(ctx.feature.id, {
					from: "DEVELOPMENT_COMPLETE",
					to: "PR_CREATING",
					owner: "worker",
					operationId: `pr-creating:${ctx.feature.id}`,
				});
				if (transition.kind === "rejected") {
					return { kind: "idle" };
				}
				await store.recordActivity({
					projectId: ctx.project.id,
					featureId: ctx.feature.id,
					attemptId: ctx.attempt.id,
					type: "pr.creating",
					summary: "Starting PR creation",
				});
			}

			let headSha: string;

			// Resolve the feature branch head before pushing (idempotent; branch already exists).
			try {
				const branch = await git.ensureFeatureBranch({
					projectRoot: ctx.project.canonicalPath,
					remoteName,
					developmentBranch: ctx.project.developmentBranch,
					featureBranch: ctx.feature.branchName,
					createIfMissing: false,
				});
				headSha = branch.headSha;
			} catch (error) {
				const reason = `Branch resolution failed: ${error instanceof Error ? error.message : "unknown"}`;
				await store.persistFailure({
					featureId: ctx.feature.id,
					targetState: "PR_CREATION_FAILED",
					reason,
					activityType: "pr.creation_failed",
				});
				await store.recordActivity({
					projectId: ctx.project.id,
					featureId: ctx.feature.id,
					type: "pr.creation_failed",
					summary: reason,
				});
				await store.recordAudit({
					projectId: ctx.project.id,
					actor: "worker",
					action: "pr.creation_failed",
					target: ctx.feature.id,
				});
				return { kind: "failed", reason };
			}

			// Push the feature branch (idempotent; aborts on head mismatch).
			try {
				const pushResult = await git.pushFeatureBranch({
					projectRoot: ctx.project.canonicalPath,
					remoteName,
					featureBranch: ctx.feature.branchName,
					expectedHeadSha: headSha,
				});
				headSha = pushResult.headSha;
			} catch (error) {
				const reason = `Push failed: ${error instanceof Error ? error.message : "unknown"}`;
				await store.persistFailure({
					featureId: ctx.feature.id,
					targetState: "PR_CREATION_FAILED",
					reason,
					activityType: "pr.creation_failed",
				});
				await store.recordActivity({
					projectId: ctx.project.id,
					featureId: ctx.feature.id,
					type: "pr.creation_failed",
					summary: reason,
				});
				await store.recordAudit({
					projectId: ctx.project.id,
					actor: "worker",
					action: "pr.creation_failed",
					target: ctx.feature.id,
				});
				return { kind: "failed", reason };
			}

			// Check for existing PR
			let prIdentity = await store.getExistingPRByFeature(ctx.feature.id);

			if (prIdentity) {
				// Already have a PR - verify it exists on GitHub
				try {
					await github.getPullRequestStatus({
						repository: {
							owner: ctx.project.githubOwner,
							repository: ctx.project.githubRepo,
							fullName: `${ctx.project.githubOwner}/${ctx.project.githubRepo}`,
						},
						number: prIdentity.number,
					});
				} catch {
					// PR might not exist on GitHub yet, need to create
					prIdentity = null;
				}
			}

			if (!prIdentity) {
				// Look up existing PR on GitHub first (idempotent path)
				const existingGitHubPR = await github.findExistingPullRequest({
					repository: {
						owner: ctx.project.githubOwner,
						repository: ctx.project.githubRepo,
						fullName: `${ctx.project.githubOwner}/${ctx.project.githubRepo}`,
					},
					headBranch: ctx.feature.branchName,
					baseBranch: ctx.project.developmentBranch,
				});

				if (existingGitHubPR) {
					prIdentity = await store.persistPRIdentity(ctx.feature.id, {
						projectId: ctx.project.id,
						repositoryOwner: ctx.project.githubOwner,
						repositoryName: ctx.project.githubRepo,
						number: existingGitHubPR.number,
						url: existingGitHubPR.url,
						headBranch: existingGitHubPR.headBranch,
						baseBranch: existingGitHubPR.baseBranch,
						originalHeadSha: existingGitHubPR.originalHeadSha,
					});
				} else {
					// Create new PR
					try {
						const created = await github.createPullRequest({
							repository: {
								owner: ctx.project.githubOwner,
								repository: ctx.project.githubRepo,
								fullName: `${ctx.project.githubOwner}/${ctx.project.githubRepo}`,
							},
							headBranch: ctx.feature.branchName,
							baseBranch: ctx.project.developmentBranch,
							title: `${ctx.feature.title}`,
							body: `Feature: ${ctx.feature.slug}`,
						});
						prIdentity = await store.persistPRIdentity(ctx.feature.id, {
							projectId: ctx.project.id,
							repositoryOwner: ctx.project.githubOwner,
							repositoryName: ctx.project.githubRepo,
							number: created.number,
							url: created.url,
							headBranch: created.headBranch,
							baseBranch: created.baseBranch,
							originalHeadSha: created.originalHeadSha,
						});
					} catch (error) {
						const reason = `PR creation failed: ${error instanceof Error ? error.message : "unknown"}`;
						await store.persistFailure({
							featureId: ctx.feature.id,
							targetState: "PR_CREATION_FAILED",
							reason,
							activityType: "pr.creation_failed",
						});
						await store.recordActivity({
							projectId: ctx.project.id,
							featureId: ctx.feature.id,
							type: "pr.creation_failed",
							summary: reason,
						});
						await store.recordAudit({
							projectId: ctx.project.id,
							actor: "worker",
							action: "pr.creation_failed",
							target: ctx.feature.id,
						});
						return { kind: "failed", reason };
					}
				}
			}

			if (!prIdentity) {
				return { kind: "failed", reason: "No pull request identity resolved" };
			}

			// Transition to CI_RUNNING
			await store.transitionFeature(ctx.feature.id, {
				from: "PR_CREATING",
				to: "CI_RUNNING",
				owner: "github_adapter",
				operationId: `ci-running:${ctx.feature.id}`,
			});

			await store.recordActivity({
				projectId: ctx.project.id,
				featureId: ctx.feature.id,
				attemptId: ctx.attempt.id,
				type: "pr.created",
				summary: `PR #${prIdentity.number} created`,
				metadata: { prNumber: prIdentity.number, url: prIdentity.url },
			});

			await store.recordAudit({
				projectId: ctx.project.id,
				actor: "worker",
				action: "pr.created",
				target: ctx.feature.id,
				prior: "PR_CREATING",
				next: "CI_RUNNING",
			});

			const result: PRHandoffOutcome = { kind: "completed", prNumber: prIdentity.number };
			await store.recordIdempotency(idempotencyKey, result);
			return result;
		},
	};
}
