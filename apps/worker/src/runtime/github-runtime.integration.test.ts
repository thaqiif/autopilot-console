/**
 * Production GitHub runtime composition (requirement 38).
 *
 * Proves the production worker boundary consumes create_pr outbox intents after
 * DEVELOPMENT_COMPLETE, pushes/reuses a single PR identity, recovers from crash
 * boundaries without duplicates, and runs scheduled current-head reconciliation
 * with monotonic observations, external merge, and closed-without-merge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createAdminAccount,
	createDatabaseClient,
	createDevelopmentAttempt,
	createFeature,
	createOutboxIntent,
	createProject,
	createPullRequestIdentity,
	createRelease,
	createTaskApproval,
	createWorkspace,
	type DatabaseClient,
	getFeatureById,
	type Sql,
} from "../../../../packages/database/src/index";
import type { GitGateway, SafePushResult } from "../../../../packages/git/src/index";
import type {
	GitHubGateway,
	PullRequestIdentity,
	PullRequestStatus,
	RepositoryRef,
	ValidateAccessResult,
} from "../../../../packages/github/src/index";
import { createGithubRuntime, type GithubRuntime } from "./github-runtime";

const ADMIN_DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/autopilot_console";

let adminClient: DatabaseClient;
let client: DatabaseClient;
let sql: Sql;
let databaseName: string;

function databaseUrlFor(name: string): string {
	const url = new URL(ADMIN_DATABASE_URL);
	url.pathname = `/${name}`;
	return url.toString();
}

const REPO: RepositoryRef = {
	owner: "acme",
	repository: "project-a",
	fullName: "acme/project-a",
};

const NOW = new Date("2026-07-18T16:00:00.000Z");

interface SeededComplete {
	attemptId: string;
	featureId: string;
	projectId: string;
	approvalId: string;
	branchName: string;
	workerId: string;
	canonicalPath: string;
}

async function seedDevelopmentComplete(options?: {
	featureState?: string;
	attemptStatus?: "SUCCEEDED" | "FAILED";
	withOutbox?: boolean;
}): Promise<SeededComplete> {
	const workspace = await createWorkspace(sql);
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID()}`,
		passwordHash: "hash",
	});
	const suffix = crypto.randomUUID();
	const project = await createProject(sql, {
		workspaceId: workspace.id,
		name: `GH Project ${suffix}`,
		slug: `gh-${suffix}`,
		githubOwner: REPO.owner,
		githubRepo: REPO.repository,
		canonicalPath: `/workspaces/gh-${suffix}`,
		developmentBranch: "main",
	});
	const release = await createRelease(sql, {
		projectId: project.id,
		name: "r1",
		version: "1.0.0",
		sortOrder: 1,
	});
	const branchName = `feature/${suffix}-login`;
	const feature = await createFeature(sql, {
		projectId: project.id,
		releaseId: release.id,
		slug: `feat-${suffix}`,
		title: "Login",
		branchName,
		state: (options?.featureState ?? "DEVELOPMENT_COMPLETE") as never,
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/login.json",
		checksum: `sha256:${suffix}`,
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [{ id: "1", passes: true }] },
		approvedByAdminId: admin.id,
	});
	const attempt = await createDevelopmentAttempt(sql, {
		projectId: project.id,
		featureId: feature.id,
		taskApprovalId: approval.id,
		branchName,
		operationKey: `develop:${suffix}`,
		status: options?.attemptStatus ?? "SUCCEEDED",
	});
	if (options?.withOutbox !== false) {
		await createOutboxIntent(sql, {
			projectId: project.id,
			featureId: feature.id,
			attemptId: attempt.id,
			kind: "create_pr",
			dedupeKey: `create_pr:${feature.id}`,
			payload: { branchName },
		});
	}
	return {
		attemptId: attempt.id,
		featureId: feature.id,
		projectId: project.id,
		approvalId: approval.id,
		branchName,
		workerId: `worker-gh-${suffix}`,
		canonicalPath: project.canonicalPath,
	};
}

class ControllableGit implements GitGateway {
	events: string[] = [];
	pushCount = 0;
	headSha = "abc123def456";
	resolveError: Error | null = null;
	pushError: Error | null = null;
	pushResult: SafePushResult | null = null;

	async ensureFeatureBranch(input: {
		projectRoot: string;
		remoteName: string;
		developmentBranch: string;
		featureBranch: string;
		createIfMissing?: boolean;
	}): Promise<{ featureBranch: string; headSha: string; created: boolean }> {
		this.events.push("git.ensure-branch");
		if (this.resolveError) throw this.resolveError;
		return { featureBranch: input.featureBranch, headSha: this.headSha, created: false };
	}

	async pushFeatureBranch(input: {
		projectRoot: string;
		remoteName: string;
		featureBranch: string;
		expectedHeadSha: string;
	}): Promise<SafePushResult> {
		this.events.push("git.push");
		this.pushCount += 1;
		if (this.pushError) throw this.pushError;
		return (
			this.pushResult ?? {
				remoteName: input.remoteName,
				featureBranch: input.featureBranch,
				headSha: this.headSha,
				alreadyUpToDate: false,
			}
		);
	}

	async preflight() {
		return {
			ok: true as const,
			identity: { root: "/tmp", headSha: this.headSha, branch: "main" },
		} as never;
	}
	async observeCommits() {
		return [];
	}
}

class ControllableGitHub implements GitHubGateway {
	events: string[] = [];
	createCount = 0;
	existingPR: PullRequestIdentity | null = null;
	createError: Error | null = null;
	statuses = new Map<number, PullRequestStatus>();
	statusErrors = new Map<number, Error>();
	nextPrNumber = 42;

	async validateAccess(): Promise<ValidateAccessResult> {
		return {
			ok: true,
			authenticated: true,
			login: "bot",
			repositoryReadable: true,
			pushFeasible: true,
			failures: [],
		};
	}

	async findExistingPullRequest(_request: {
		repository: RepositoryRef;
		headBranch: string;
		baseBranch: string;
	}): Promise<PullRequestIdentity | null> {
		this.events.push("github.find-pr");
		return this.existingPR;
	}

	async createPullRequest(request: {
		repository: RepositoryRef;
		headBranch: string;
		baseBranch: string;
		title: string;
		body: string;
	}): Promise<PullRequestIdentity> {
		this.events.push("github.create-pr");
		this.createCount += 1;
		if (this.createError) throw this.createError;
		const number = this.nextPrNumber++;
		return {
			repository: request.repository,
			number,
			url: `https://github.com/${request.repository.fullName}/pull/${number}`,
			headBranch: request.headBranch,
			baseBranch: request.baseBranch,
			originalHeadSha: "abc123def456",
		};
	}

	async getPullRequestStatus(request: {
		repository: RepositoryRef;
		number: number;
	}): Promise<PullRequestStatus> {
		this.events.push(`github.get-status:${request.number}`);
		const err = this.statusErrors.get(request.number);
		if (err) throw err;
		return (
			this.statuses.get(request.number) ?? {
				repository: request.repository,
				number: request.number,
				url: `https://github.com/${request.repository.fullName}/pull/${request.number}`,
				state: "open",
				currentHeadSha: "abc123def456",
				headBranch: "feature/x",
				baseBranch: "main",
				checks: [],
				checkSummary: "none",
				reviewDecision: "NONE",
				mergeCommitSha: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: null,
				mergeable: null,
			}
		);
	}

	setStatus(
		number: number,
		status: Partial<PullRequestStatus> & { state?: PullRequestStatus["state"] },
	) {
		const base = this.statuses.get(number);
		this.statuses.set(number, {
			repository: REPO,
			number,
			url: `https://github.com/acme/project-a/pull/${number}`,
			state: "open",
			currentHeadSha: "abc123def456",
			headBranch: "feature/x",
			baseBranch: "main",
			checks: [],
			checkSummary: "none",
			reviewDecision: "NONE",
			mergeCommitSha: null,
			mergedAt: null,
			closedAt: null,
			updatedAt: null,
			mergeable: null,
			...base,
			...status,
		});
	}
}

function composeRuntime(input: {
	workerId: string;
	git?: ControllableGit;
	github?: ControllableGitHub;
	pollIntervalMs?: number;
	now?: () => Date;
}): {
	runtime: GithubRuntime;
	git: ControllableGit;
	github: ControllableGitHub;
} {
	const git = input.git ?? new ControllableGit();
	const github = input.github ?? new ControllableGitHub();
	const runtime = createGithubRuntime({
		sql,
		git,
		github,
		workerId: input.workerId,
		pollIntervalMs: input.pollIntervalMs ?? 60_000,
		handoffPollIntervalMs: 10,
		now: input.now ?? (() => NOW),
		sleep: async () => {},
	});
	return { runtime, git, github };
}

beforeAll(async () => {
	adminClient = createDatabaseClient(ADMIN_DATABASE_URL);
	databaseName = `gh_rt_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
	await adminClient.sql.unsafe(`CREATE DATABASE "${databaseName}"`);
	client = createDatabaseClient(databaseUrlFor(databaseName));
	sql = client.sql;
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			idempotency_records,
			outbox_intents,
			scheduled_reconciliation_jobs,
			activity_events,
			audit_events,
			failure_records,
			progress_snapshots,
			diagnostic_log_chunks,
			development_job_attempts,
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			worker_registrations,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
});

afterAll(async () => {
	await client?.end();
	if (adminClient && databaseName) {
		await adminClient.sql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
	}
	await adminClient?.end();
});

describe("production GitHub runtime composition", () => {
	test("consumes create_pr handoff intents, pushes branch, and persists exactly one PR identity", async () => {
		const seed = await seedDevelopmentComplete();
		const { runtime, git, github } = composeRuntime({ workerId: seed.workerId });

		const first = await runtime.processPendingHandoffs();
		expect(first.processed).toBe(1);
		expect(first.outcomes[0]?.kind).toBe("completed");
		expect(git.pushCount).toBe(1);
		expect(github.createCount).toBe(1);

		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("CI_RUNNING");

		const prs =
			await sql`SELECT number, head_branch FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		expect(prs).toHaveLength(1);
		expect(Number(prs[0]?.number)).toBe(42);

		const outbox = await sql`
			SELECT status FROM outbox_intents WHERE kind = 'create_pr' AND feature_id = ${seed.featureId}
		`;
		expect(outbox[0]?.status).toBe("completed");

		const activity = await sql`
			SELECT type FROM activity_events WHERE feature_id = ${seed.featureId} ORDER BY created_at
		`;
		const types = activity.map((row) => row.type as string);
		expect(types).toContain("pr.creating");
		expect(types).toContain("pr.created");

		// Idle second pass — no duplicate push/PR
		const second = await runtime.processPendingHandoffs();
		expect(second.processed).toBe(0);
		expect(git.pushCount).toBe(1);
		expect(github.createCount).toBe(1);
		const prsAgain =
			await sql`SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		expect(Number(prsAgain[0]?.n)).toBe(1);
	});

	test("reuses an existing matching GitHub PR without creating a duplicate", async () => {
		const seed = await seedDevelopmentComplete();
		const github = new ControllableGitHub();
		github.existingPR = {
			repository: REPO,
			number: 17,
			url: "https://github.com/acme/project-a/pull/17",
			headBranch: seed.branchName,
			baseBranch: "main",
			originalHeadSha: "existing-sha",
		};
		const { runtime } = composeRuntime({ workerId: seed.workerId, github });

		const result = await runtime.processPendingHandoffs();
		expect(result.outcomes[0]?.kind).toBe("completed");
		expect(github.createCount).toBe(0);
		expect(github.events).toContain("github.find-pr");

		const prs = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		expect(prs).toHaveLength(1);
		expect(Number(prs[0]?.number)).toBe(17);
	});

	test("crash before PR creation recovers without duplicate PR and completes idempotently", async () => {
		const seed = await seedDevelopmentComplete();
		const git = new ControllableGit();
		const github = new ControllableGitHub();
		// First attempt: push succeeds, create fails (crash mid-handoff)
		github.createError = new Error("simulated crash after push");
		const { runtime } = composeRuntime({ workerId: seed.workerId, git, github });

		const failed = await runtime.processPendingHandoffs();
		expect(failed.outcomes[0]?.kind).toBe("failed");
		expect(git.pushCount).toBe(1);

		// Feature may be PR_CREATION_FAILED; re-queue by resetting to DEVELOPMENT_COMPLETE
		// and inserting a fresh pending intent is owner-driven. Crash recovery for
		// PR_CREATING is the durable path: transition already happened, existing PR found.
		await sql`
			UPDATE features SET state = 'PR_CREATING', row_version = row_version + 1
			WHERE id = ${seed.featureId}
		`;
		await sql`
			UPDATE outbox_intents
			SET status = 'pending', claimed_by = NULL, claimed_at = NULL, completed_at = NULL, last_error = NULL
			WHERE feature_id = ${seed.featureId}
		`;
		// Clear failed idempotency so the handoff re-runs the recovery path.
		await sql`DELETE FROM idempotency_records WHERE attempt_id = ${seed.attemptId}`;

		github.createError = null;
		github.existingPR = {
			repository: REPO,
			number: 99,
			url: "https://github.com/acme/project-a/pull/99",
			headBranch: seed.branchName,
			baseBranch: "main",
			originalHeadSha: "abc123def456",
		};

		const createCountBeforeRecovery = github.createCount;
		const recovered = await runtime.processPendingHandoffs();
		expect(recovered.outcomes[0]?.kind).toBe("completed");
		// Recovery reuses the existing GitHub PR — no additional create.
		expect(github.createCount).toBe(createCountBeforeRecovery);

		const prs = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		expect(prs).toHaveLength(1);
		expect(Number(prs[0]?.number)).toBe(99);

		// Idempotent re-entry after success
		const again = await runtime.processPendingHandoffs();
		expect(again.processed).toBe(0);
		expect(git.pushCount).toBe(2); // one failed attempt push + one recovery push
		expect(github.createCount).toBe(createCountBeforeRecovery);
	});

	test("duplicate handoff after success returns the stored outcome without side effects", async () => {
		const seed = await seedDevelopmentComplete();
		const { runtime, git, github } = composeRuntime({ workerId: seed.workerId });
		await runtime.processPendingHandoffs();
		const pushAfterFirst = git.pushCount;
		const createAfterFirst = github.createCount;

		// Re-open a pending intent to force the consumer to re-claim; handoff is still idempotent.
		await sql`
			INSERT INTO outbox_intents (project_id, feature_id, attempt_id, kind, dedupe_key, payload, status)
			VALUES (
				${seed.projectId},
				${seed.featureId},
				${seed.attemptId},
				'create_pr',
				${`create_pr_retry:${seed.featureId}`},
				'{}'::jsonb,
				'pending'
			)
		`;

		const second = await runtime.processPendingHandoffs();
		expect(second.processed).toBe(1);
		expect(second.outcomes[0]?.kind).toBe("completed");
		expect(git.pushCount).toBe(pushAfterFirst);
		expect(github.createCount).toBe(createAfterFirst);

		const prCount =
			await sql`SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		expect(Number(prCount[0]?.n)).toBe(1);

		const activityCount = await sql`
			SELECT count(*)::int AS n FROM activity_events
			WHERE feature_id = ${seed.featureId} AND type = 'pr.created'
		`;
		expect(Number(activityCount[0]?.n)).toBe(1);
	});

	test("polls open PRs on demand and applies current-head CI observations", async () => {
		const seed = await seedDevelopmentComplete();
		const { runtime, github } = composeRuntime({ workerId: seed.workerId });
		await runtime.processPendingHandoffs();
		const [pr] = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		const prNumber = Number(pr?.number);

		github.setStatus(prNumber, {
			state: "open",
			currentHeadSha: "abc123def456",
			checkSummary: "passing",
			reviewDecision: "NONE",
			checks: [{ name: "ci", conclusion: "success", bucket: "pass", headSha: "abc123def456" }],
		});

		const polled = await runtime.pollOnce();
		expect(polled).toBe(1);

		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("PR_REVIEW");

		const observed = await sql`
			SELECT observed_head_sha, observed_state FROM pull_requests WHERE feature_id = ${seed.featureId}
		`;
		expect(observed[0]?.observed_head_sha).toBe("abc123def456");
	});

	test("stale observations never overwrite newer head or state", async () => {
		const seed = await seedDevelopmentComplete();
		let clock = new Date("2026-07-18T16:00:00.000Z");
		const { runtime, github } = composeRuntime({
			workerId: seed.workerId,
			now: () => new Date(clock.getTime()),
		});
		await runtime.processPendingHandoffs();
		const [pr] = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		const prNumber = Number(pr?.number);

		// Newer observation first
		clock = new Date("2026-07-18T16:05:00.000Z");
		github.setStatus(prNumber, {
			state: "open",
			currentHeadSha: "new-sha",
			checkSummary: "passing",
			reviewDecision: "NONE",
		});
		await runtime.pollOnce();

		// Older poll attempt
		clock = new Date("2026-07-18T16:01:00.000Z");
		github.setStatus(prNumber, {
			state: "open",
			currentHeadSha: "old-sha",
			checkSummary: "failing",
			reviewDecision: "NONE",
		});
		await runtime.pollOnce();

		const observed = await sql`
			SELECT observed_head_sha FROM pull_requests WHERE feature_id = ${seed.featureId}
		`;
		expect(observed[0]?.observed_head_sha).toBe("new-sha");
		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("PR_REVIEW");
	});

	test("external merge persists DEVELOPMENT_MERGED with activity and audit", async () => {
		const seed = await seedDevelopmentComplete();
		const { runtime, github } = composeRuntime({ workerId: seed.workerId });
		await runtime.processPendingHandoffs();
		const [pr] = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		const prNumber = Number(pr?.number);

		github.setStatus(prNumber, {
			state: "merged",
			currentHeadSha: "abc123def456",
			checkSummary: "passing",
			reviewDecision: "APPROVED",
			mergedAt: NOW.toISOString(),
			mergeCommitSha: "merge-sha",
		});
		await runtime.pollOnce();

		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("DEVELOPMENT_MERGED");

		const activity = await sql`
			SELECT type FROM activity_events WHERE feature_id = ${seed.featureId} AND type = 'pr.merged'
		`;
		expect(activity).toHaveLength(1);
		const audit = await sql`
			SELECT action FROM audit_events WHERE target_id = ${seed.featureId} AND action = 'pr.merged'
		`;
		expect(audit).toHaveLength(1);
	});

	test("closed without merge persists BLOCKED with activity and audit", async () => {
		const seed = await seedDevelopmentComplete();
		const { runtime, github } = composeRuntime({ workerId: seed.workerId });
		await runtime.processPendingHandoffs();
		const [pr] = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		const prNumber = Number(pr?.number);

		github.setStatus(prNumber, {
			state: "closed",
			currentHeadSha: "abc123def456",
			checkSummary: "none",
			reviewDecision: "NONE",
			closedAt: NOW.toISOString(),
		});
		await runtime.pollOnce();

		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("BLOCKED");

		const activity = await sql`
			SELECT type FROM activity_events
			WHERE feature_id = ${seed.featureId} AND type = 'pr.closed_without_merge'
		`;
		expect(activity).toHaveLength(1);
		const audit = await sql`
			SELECT action FROM audit_events
			WHERE target_id = ${seed.featureId} AND action = 'pr.closed_without_merge'
		`;
		expect(audit).toHaveLength(1);
	});

	test("run loop drains handoff intents then polls until aborted", async () => {
		const seed = await seedDevelopmentComplete();
		const github = new ControllableGitHub();
		// Domain clock must advance so successive polls are not treated as stale.
		let clockMs = NOW.getTime();
		const { runtime } = composeRuntime({
			workerId: seed.workerId,
			github,
			pollIntervalMs: 1,
			now: () => {
				clockMs += 1_000;
				return new Date(clockMs);
			},
		});

		const controller = new AbortController();
		const loop = runtime.run(controller.signal);

		// Allow the loop to process handoff
		for (let i = 0; i < 50; i++) {
			const outbox = await sql`
				SELECT status FROM outbox_intents WHERE feature_id = ${seed.featureId}
			`;
			if (outbox[0]?.status === "completed") break;
			await Bun.sleep(5);
		}

		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("CI_RUNNING");

		const [pr] = await sql`SELECT number FROM pull_requests WHERE feature_id = ${seed.featureId}`;
		github.setStatus(Number(pr?.number), {
			state: "merged",
			currentHeadSha: "abc123def456",
			checkSummary: "passing",
			mergedAt: NOW.toISOString(),
		});

		for (let i = 0; i < 50; i++) {
			const f = await getFeatureById(sql, seed.featureId);
			if (f?.state === "DEVELOPMENT_MERGED") break;
			await Bun.sleep(5);
		}

		controller.abort();
		await loop;

		const finalFeature = await getFeatureById(sql, seed.featureId);
		expect(finalFeature?.state).toBe("DEVELOPMENT_MERGED");
	});

	test("production main composition entry exports createGithubRuntime for apps/worker main", async () => {
		// Ensures the composition surface is the one main.ts is expected to call.
		expect(typeof createGithubRuntime).toBe("function");
		const seed = await seedDevelopmentComplete({ withOutbox: false });
		// Also prove pre-seeded PR identity can be reconciled without handoff.
		await createPullRequestIdentity(sql, {
			projectId: seed.projectId,
			featureId: seed.featureId,
			repositoryOwner: REPO.owner,
			repositoryName: REPO.repository,
			number: 7,
			url: "https://github.com/acme/project-a/pull/7",
			headBranch: seed.branchName,
			baseBranch: "main",
			originalHeadSha: "seed-sha",
		});
		await sql`
			UPDATE features SET state = 'CI_RUNNING', row_version = row_version + 1
			WHERE id = ${seed.featureId}
		`;
		const github = new ControllableGitHub();
		github.setStatus(7, {
			state: "open",
			currentHeadSha: "seed-sha",
			checkSummary: "failing",
			checks: [{ name: "ci", conclusion: "failure", bucket: "fail", headSha: "seed-sha" }],
		});
		const { runtime } = composeRuntime({ workerId: seed.workerId, github });
		await runtime.pollOnce();
		const feature = await getFeatureById(sql, seed.featureId);
		expect(feature?.state).toBe("CI_FAILED");
	});
});
