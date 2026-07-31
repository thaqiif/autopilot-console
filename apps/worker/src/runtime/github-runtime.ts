/**
 * Production GitHub runtime — durable PR handoff consumer + scheduled reconciliation.
 *
 * External Git and GitHub effects begin only from persisted outbox intents and
 * open pull-request rows. Browser sessions never own push/PR/poll work.
 */
import {
	claimNextOutboxIntent,
	completeOutboxIntent,
	failOutboxIntent,
	type OutboxIntentRow,
	type Queryable,
} from "../../../../packages/database/src/index";
import type { GitGateway } from "../../../../packages/git/src/index";
import type { GitHubGateway, RepositoryRef } from "../../../../packages/github/src/index";
import { createPostgresPrHandoffStore } from "../github/pr-handoff-store";
import {
	createPRHandoffWorker,
	type PRHandoffOutcome,
	type PRHandoffWorker,
} from "../github/pr-handoff-worker";
import { createPostgresPrReconciliationStore } from "../github/pr-reconciliation-store";
import {
	createPRReconciliationWorker,
	type PRReconciliationWorker,
} from "../github/pr-reconciliation-worker";

export type HandoffProcessResult = {
	processed: number;
	outcomes: PRHandoffOutcome[];
};

export interface GithubRuntime {
	/** Claim and process every pending create_pr outbox intent once. */
	processPendingHandoffs(): Promise<HandoffProcessResult>;
	/** Poll every open Phase 1 PR for current-head observations. */
	pollOnce(): Promise<number>;
	/** Drain handoff intents and schedule reconciliation until aborted. */
	run(signal: AbortSignal): Promise<void>;
}

export interface GithubRuntimeOptions {
	sql: Queryable;
	git: GitGateway;
	github: GitHubGateway;
	workerId: string;
	/** Interval between scheduled reconciliation polls (ms). */
	pollIntervalMs?: number;
	/** Interval between handoff outbox claim attempts while idle (ms). */
	handoffPollIntervalMs?: number;
	remoteName?: string;
	now?: () => Date;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Optional injectables for tests. */
	handoffWorker?: PRHandoffWorker;
	reconciliationWorker?: PRReconciliationWorker;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * GitHub gateway adapter that rewrites repository identity from pull_requests
 * so a single reconciliation worker can poll multi-project open PRs.
 */
function createRepositoryResolvingGitHub(sql: Queryable, github: GitHubGateway): GitHubGateway {
	return {
		validateAuthentication: () => github.validateAuthentication(),
		validateAccess: (request) => github.validateAccess(request),
		findExistingPullRequest: (request) => github.findExistingPullRequest(request),
		createPullRequest: (request) => github.createPullRequest(request),
		async getPullRequestStatus(request) {
			const rows = await sql`
				SELECT repository_owner, repository_name
				FROM pull_requests
				WHERE number = ${request.number}
				LIMIT 1
			`;
			const row = rows[0];
			const repository: RepositoryRef = row
				? {
						owner: row.repository_owner as string,
						repository: row.repository_name as string,
						fullName: `${row.repository_owner as string}/${row.repository_name as string}`,
					}
				: request.repository;
			return github.getPullRequestStatus({
				repository,
				number: request.number,
			});
		},
	};
}

export function createGithubRuntime(options: GithubRuntimeOptions): GithubRuntime {
	const now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? defaultSleep;
	const pollIntervalMs = options.pollIntervalMs ?? 60_000;
	const handoffPollIntervalMs = options.handoffPollIntervalMs ?? 1_000;
	const sql = options.sql;

	const handoffStore = createPostgresPrHandoffStore(sql, now);
	const reconStore = createPostgresPrReconciliationStore({ sql, now });

	const handoffWorker =
		options.handoffWorker ??
		createPRHandoffWorker({
			store: handoffStore,
			git: options.git,
			github: options.github,
			workerId: options.workerId,
			remoteName: options.remoteName,
			now,
		});

	const reconciliationWorker =
		options.reconciliationWorker ??
		createPRReconciliationWorker({
			store: reconStore,
			github: createRepositoryResolvingGitHub(sql, options.github),
			// Placeholder; the gateway adapter rewrites repository per PR number.
			repository: { owner: "_", repository: "_", fullName: "_/_" },
			now,
		});

	return {
		processPendingHandoffs,
		pollOnce: () => reconciliationWorker.pollAll(),
		run,
	};

	async function processPendingHandoffs(): Promise<HandoffProcessResult> {
		const outcomes: PRHandoffOutcome[] = [];
		for (;;) {
			const intent = await claimNextOutboxIntent(sql, {
				workerId: options.workerId,
				kind: "create_pr",
			});
			if (!intent) break;
			outcomes.push(await processOneIntent(intent));
		}
		return { processed: outcomes.length, outcomes };
	}

	async function processOneIntent(intent: OutboxIntentRow): Promise<PRHandoffOutcome> {
		const attemptId = intent.attemptId;
		if (!attemptId) {
			await failOutboxIntent(sql, {
				intentId: intent.id,
				workerId: options.workerId,
				error: "create_pr intent missing attemptId",
			});
			return { kind: "failed", reason: "create_pr intent missing attemptId" };
		}
		try {
			const outcome = await handoffWorker.handoff(attemptId);
			if (outcome.kind === "failed") {
				await failOutboxIntent(sql, {
					intentId: intent.id,
					workerId: options.workerId,
					error: outcome.reason,
				});
				return outcome;
			}
			await completeOutboxIntent(sql, {
				intentId: intent.id,
				workerId: options.workerId,
			});
			return outcome;
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown handoff error";
			await failOutboxIntent(sql, {
				intentId: intent.id,
				workerId: options.workerId,
				error: message,
			});
			return { kind: "failed", reason: message };
		}
	}

	async function run(signal: AbortSignal): Promise<void> {
		// Wall-clock scheduling so injected domain clocks do not freeze poll cadence.
		let lastPollAt = 0;
		while (!signal.aborted) {
			await processPendingHandoffs();
			const wallMs = Date.now();
			if (wallMs - lastPollAt >= pollIntervalMs) {
				await reconciliationWorker.pollAll();
				lastPollAt = wallMs;
			}
			await sleep(Math.min(handoffPollIntervalMs, pollIntervalMs), signal);
		}
	}
}
