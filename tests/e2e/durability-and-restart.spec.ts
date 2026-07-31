/**
 * Durability and restart E2E tests (requirement 42).
 *
 * Proves browser/session, API, and worker restarts via actual component
 * dispose/recreate against the same PostgreSQL database:
 *   - session rotation leaves queued/running work reconstructable from APIs
 *   - API process replacement does not stop or duplicate a live attempt
 *   - worker replacement either keeps singular live ownership or marks
 *     expired ownership INTERRUPTED with evidence and no automatic retry
 *   - restarts mid push / PR create / GitHub poll reconcile to one external
 *     effect and monotonic feature state
 *
 * No arbitrary sleeps — waits use HoldGate.whenWaiting() and bounded state polls.
 * No conditional success assertions or multi-state allowances.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevelopmentAttempt, getFeatureById } from "../../packages/database/src/index";
import {
	ADMIN_PASSWORD,
	ADMIN_USERNAME,
	bootstrapPhase1,
	type Phase1Context,
	truncateAll,
} from "../fixtures/phase-1-seed";

let ctx: Phase1Context;
let tempDir: string;

const VALID_TASK = {
	name: "durability-test",
	description: "Durability test task",
	goals: ["Test durability"],
	nonGoals: [],
	requirements: [
		{
			id: "1",
			description: "Requirement 1",
			acceptance: ["Criterion 1"],
			passes: false,
		},
	],
};

/** Bounded wait for a DB-visible predicate without wall-clock sleeps. */
async function waitUntil(
	predicate: () => Promise<boolean>,
	label: string,
	maxTurns = 100,
): Promise<void> {
	for (let i = 0; i < maxTurns; i += 1) {
		if (await predicate()) return;
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`waitUntil timed out: ${label}`);
}

async function loginApi(): Promise<string> {
	const loginResult = await ctx.api.directLogin({
		username: ADMIN_USERNAME,
		password: ADMIN_PASSWORD,
	});
	expect(loginResult.ok).toBe(true);
	if (!loginResult.ok) throw new Error("Login failed");
	return loginResult.token;
}

async function apiCall(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const csrf = await ctx.api.issueCsrf(token);
	const headers: Record<string, string> = {
		Cookie: `ac_session=${token}`,
		"x-csrf-token": csrf,
	};
	let jsonBody: string | undefined;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		jsonBody = JSON.stringify(body);
	}
	return ctx.api.app.request(path, { method, headers, body: jsonBody });
}

/** Register a project, create release, feature, attach task, approve & queue. */
async function setupQueuedFeature(
	token: string,
	name: string,
	slug: string,
): Promise<{ projectId: string; featureId: string; attemptId: string; branchName: string }> {
	const projectDir = join(tempDir, slug);
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, ".git"), "");

	const createRes = await apiCall(token, "POST", "/api/projects", {
		name,
		slug,
		githubOwner: "acme",
		githubRepo: slug,
		workspacePath: projectDir,
		developmentBranch: "main",
	});
	expect(createRes.status).toBe(201);
	const projectBody = await createRes.json();
	const projectId = projectBody.data.id as string;

	const releaseRes = await apiCall(token, "POST", "/api/releases", {
		projectId,
		name: `v1-${slug}`,
		version: `1.0.0-${slug}`,
	});
	expect(releaseRes.status).toBe(201);
	const releaseBody = await releaseRes.json();
	const releaseId = releaseBody.data.id as string;

	const featureRes = await apiCall(token, "POST", "/api/features", {
		projectId,
		releaseId,
		title: `Feature ${name}`,
		slug: `feature-${slug}`,
	});
	expect(featureRes.status).toBe(201);
	const featureBody = await featureRes.json();
	const featureId = featureBody.data.id as string;
	const branchName = String(featureBody.data.branchName ?? featureBody.data.branch_name ?? "");

	const taskPath = join(projectDir, "docs", "tasks", `${slug}.json`);
	await mkdir(join(projectDir, "docs", "tasks"), { recursive: true });
	await writeFile(taskPath, JSON.stringify(VALID_TASK, null, 2));

	const attachRes = await apiCall(token, "POST", `/api/features/${featureId}/task`, {
		relativeTaskPath: `docs/tasks/${slug}.json`,
	});
	expect(attachRes.status).toBe(200);
	const attachBody = await attachRes.json();
	const checksum = attachBody.data?.approval?.checksum ?? attachBody.data?.checksum;
	expect(checksum).toBeTruthy();

	const approveRes = await apiCall(token, "POST", `/api/features/${featureId}/approve-queue`, {
		projectId,
		featureId,
		displayedChecksum: checksum,
		operationKey: `approve-${featureId}-durability`,
		confirmation: "approve-and-queue",
	});
	expect(approveRes.status).toBe(200);
	const approveBody = await approveRes.json();
	const attemptId = approveBody.data.attempt.id as string;

	return { projectId, featureId, attemptId, branchName };
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "e2e-durability-"));
	ctx = await bootstrapPhase1({ workspaceRoot: tempDir });
});

afterAll(async () => {
	await ctx.stopDevelopmentSupervisor();
	// Release any hold that might keep the suite process alive.
	ctx.holds.autopilotWait.disable();
	ctx.holds.gitPush.disable();
	ctx.holds.createPr.disable();
	ctx.holds.githubPoll.disable();
	await ctx.client.end();
	await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	await ctx.stopDevelopmentSupervisor();
	ctx.resetExternalAdapterState();
	await truncateAll(ctx.sql);
	await ctx.api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
	await ctx.ensureWorkerRegistration();
});

describe("durability and restart — real component replacement", () => {
	test("browser/session recreation leaves queued work reconstructable from APIs", async () => {
		const token1 = await loginApi();
		const { attemptId, featureId } = await setupQueuedFeature(
			token1,
			"Browser Restart",
			"browser-restart",
		);

		// Close the browser session.
		const logout = await ctx.api.logout(token1);
		expect(logout.status).toBe(200);
		const closed = await ctx.api.app.request("/api/overview", {
			method: "GET",
			headers: { Cookie: `ac_session=${token1}` },
		});
		expect(closed.status).toBe(401);

		// Recreate a browser session against the same API/database.
		const token2 = await loginApi();
		expect(token2).not.toBe(token1);

		const attempt = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(attempt?.status).toBe("QUEUED");

		const overview = await apiCall(token2, "GET", "/api/overview");
		expect(overview.status).toBe(200);
		const overviewBody = await overview.json();
		expect(overviewBody.ok).toBe(true);

		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("QUEUED");
		const featureRes = await apiCall(token2, "GET", `/api/features/${featureId}`);
		expect(featureRes.status).toBe(200);
		const featureBody = await featureRes.json();
		expect(featureBody.ok).toBe(true);
	});

	test("API dispose/recreate while worker runs does not stop or duplicate the attempt", async () => {
		const token = await loginApi();
		const { attemptId, featureId } = await setupQueuedFeature(token, "Api Restart", "api-restart");

		// Hold Autopilot so the attempt stays RUNNING under a live supervisor slot.
		ctx.holds.autopilotWait.enable();
		const supervisor = ctx.startDevelopmentSupervisor();

		await waitUntil(async () => {
			const attempt = await getDevelopmentAttempt(ctx.sql, attemptId);
			return attempt?.status === "RUNNING";
		}, "attempt becomes RUNNING under live worker");

		const apiBefore = ctx.lifecycleGeneration.api;
		const apiAppBefore = ctx.api.app;
		const restarted = await ctx.restartApi();
		expect(restarted.generation).toBe(apiBefore + 1);
		expect(ctx.api.app).not.toBe(apiAppBefore);

		// Session from the disposed API is still valid against the same DB (shared sessions table).
		// A fresh login proves the recreated API works.
		const tokenAfter = await loginApi();
		const attemptMid = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(attemptMid?.status).toBe("RUNNING");

		const overview = await apiCall(tokenAfter, "GET", "/api/overview");
		expect(overview.status).toBe(200);

		// Release Autopilot; the original worker completes the singular attempt.
		ctx.holds.autopilotWait.disable();
		await waitUntil(async () => {
			const attempt = await getDevelopmentAttempt(ctx.sql, attemptId);
			return attempt?.status === "SUCCEEDED";
		}, "attempt succeeds after API restart");

		await supervisor.stop();

		const attempts = await ctx.sql`
			SELECT id, status FROM development_job_attempts WHERE feature_id = ${featureId}
		`;
		expect(attempts.length).toBe(1);
		expect(attempts[0]?.status).toBe("SUCCEEDED");
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("DEVELOPMENT_COMPLETE");
	});

	test("worker restart without lease expiry keeps singular RUNNING ownership", async () => {
		const token = await loginApi();
		const live = await setupQueuedFeature(token, "Worker Live", "worker-live");
		ctx.holds.autopilotWait.enable();
		const supervisor = ctx.startDevelopmentSupervisor();
		await waitUntil(async () => {
			const attempt = await getDevelopmentAttempt(ctx.sql, live.attemptId);
			return attempt?.status === "RUNNING";
		}, "attempt RUNNING before live-lease restart");

		const genBefore = ctx.lifecycleGeneration.development;
		const runtimeBefore = ctx.developmentRuntime;
		const liveRestart = await ctx.restartDevelopmentWorker({
			expireLeases: false,
			reconcileOrphans: false,
		});
		expect(liveRestart.generation).toBe(genBefore + 1);
		expect(ctx.developmentRuntime).not.toBe(runtimeBefore);
		expect(liveRestart.reconciled).toBe(0);

		const duringLive = await ctx.sql`
			SELECT id, status FROM development_job_attempts WHERE feature_id = ${live.featureId}
		`;
		expect(duringLive.length).toBe(1);
		expect(duringLive[0]?.status).toBe("RUNNING");

		// Restarted supervisor must not claim a second attempt for the same feature.
		const second = ctx.startDevelopmentSupervisor();
		await Promise.resolve();
		const still = await ctx.sql`
			SELECT count(*)::int AS n FROM development_job_attempts WHERE feature_id = ${live.featureId}
		`;
		expect(Number(still[0]?.n)).toBe(1);

		await second.stop().catch(() => undefined);
		await supervisor.stop().catch(() => undefined);
	});

	test("worker restart with expired lease marks INTERRUPTED with evidence and no auto-retry", async () => {
		const token = await loginApi();
		const expired = await setupQueuedFeature(token, "Worker Expired", "worker-expired");
		ctx.holds.autopilotWait.enable();
		const supervisor = ctx.startDevelopmentSupervisor();
		await waitUntil(async () => {
			const attempt = await getDevelopmentAttempt(ctx.sql, expired.attemptId);
			return attempt?.status === "RUNNING" && attempt.leaseExpiresAt != null;
		}, "attempt RUNNING with lease before expired restart");

		// Prove the row is still running and lease is in the future relative to the domain clock.
		const before = await getDevelopmentAttempt(ctx.sql, expired.attemptId);
		expect(before?.status).toBe("RUNNING");
		expect(before?.leaseExpiresAt?.getTime()).toBeGreaterThan(ctx.clock.now().getTime());

		const expiredRestart = await ctx.restartDevelopmentWorker({
			expireLeases: true,
			reconcileOrphans: true,
		});
		expect(expiredRestart.reconciled).toBeGreaterThanOrEqual(1);

		const interrupted = await getDevelopmentAttempt(ctx.sql, expired.attemptId);
		expect(interrupted?.status).toBe("INTERRUPTED");
		expect((await getFeatureById(ctx.sql, expired.featureId))?.state).toBe(
			"DEVELOPMENT_INTERRUPTED",
		);

		const failures = await ctx.sql`
			SELECT category FROM failure_records WHERE attempt_id = ${expired.attemptId}
		`;
		expect(failures.length).toBeGreaterThanOrEqual(1);
		const activity = await ctx.sql`
			SELECT type FROM activity_events
			WHERE attempt_id = ${expired.attemptId} AND type = 'development.interrupted'
		`;
		expect(activity.length).toBeGreaterThanOrEqual(1);
		const audit = await ctx.sql`
			SELECT action FROM audit_events
			WHERE attempt_id = ${expired.attemptId} AND action = 'development.interrupt'
		`;
		expect(audit.length).toBeGreaterThanOrEqual(1);

		ctx.holds.autopilotWait.disable();
		const outcomes = await ctx.drainDevelopmentWork();
		expect(outcomes.some((o) => o.kind === "completed" && o.attemptId === expired.attemptId)).toBe(
			false,
		);
		const attempts = await ctx.sql`
			SELECT id, status FROM development_job_attempts WHERE feature_id = ${expired.featureId}
		`;
		expect(attempts.length).toBe(1);
		expect(attempts[0]?.status).toBe("INTERRUPTED");
		await supervisor.stop().catch(() => undefined);
	});

	test("restart during git push reconciles to one push effect and monotonic state", async () => {
		const token = await loginApi();
		const { attemptId, featureId } = await setupQueuedFeature(
			token,
			"Push Restart",
			"push-restart",
		);

		// Complete development so a create_pr outbox intent exists.
		const outcomes = await ctx.drainDevelopmentWork();
		expect(outcomes.some((o) => o.kind === "completed" && o.attemptId === attemptId)).toBe(true);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("DEVELOPMENT_COMPLETE");
		ctx.gitState.pushes.length = 0;

		ctx.holds.gitPush.enable();
		const handoffPromise = ctx.githubRuntime.processPendingHandoffs();
		await ctx.holds.gitPush.whenWaiting();
		expect(ctx.gitState.pushes.length).toBe(0);

		// Dispose/recreate GitHub runtime mid-push (abandons in-flight push).
		const genBefore = ctx.lifecycleGeneration.github;
		const runtimeBefore = ctx.githubRuntime;
		const restarted = await ctx.restartGithubRuntime();
		expect(restarted.generation).toBe(genBefore + 1);
		expect(ctx.githubRuntime).not.toBe(runtimeBefore);
		void handoffPromise;

		// Drive the recreated runtime to completion from requeued intent.
		const after = await ctx.githubRuntime.processPendingHandoffs();
		expect(after.processed).toBeGreaterThanOrEqual(1);

		await waitUntil(async () => {
			const rows = await ctx.sql`
				SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${featureId}
			`;
			return Number(rows[0]?.n) === 1;
		}, "exactly one PR after push restart");

		expect(ctx.gitState.pushes.length).toBe(1);
		const feature = await getFeatureById(ctx.sql, featureId);
		expect(feature?.state).toBe("CI_RUNNING");
	});

	test("restart during PR creation reconciles to one PR and one push", async () => {
		const token = await loginApi();
		const { attemptId, featureId } = await setupQueuedFeature(token, "Pr Restart", "pr-restart");

		const outcomes = await ctx.drainDevelopmentWork();
		expect(outcomes.some((o) => o.kind === "completed" && o.attemptId === attemptId)).toBe(true);
		// Development does not push; clear any leaked adapter effects from prior cases.
		ctx.gitState.pushes.length = 0;

		// Let push succeed, block only PR create.
		ctx.holds.createPr.enable();
		const handoffPromise = ctx.githubRuntime.processPendingHandoffs();
		await ctx.holds.createPr.whenWaiting();
		// Push already recorded before PR create hold (exactly one distinct branch head).
		const pushBranches = new Set(ctx.gitState.pushes.map((p) => p.featureBranch));
		expect(pushBranches.size).toBe(1);

		const genBefore = ctx.lifecycleGeneration.github;
		await ctx.restartGithubRuntime();
		expect(ctx.lifecycleGeneration.github).toBe(genBefore + 1);
		void handoffPromise;

		const after = await ctx.githubRuntime.processPendingHandoffs();
		expect(after.processed).toBeGreaterThanOrEqual(1);

		await waitUntil(async () => {
			const rows = await ctx.sql`
				SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${featureId}
			`;
			return Number(rows[0]?.n) === 1;
		}, "exactly one PR after PR-create restart");

		const uniquePushes = new Set(
			ctx.gitState.pushes.map((p) => `${p.featureBranch}@${p.expectedHeadSha}`),
		);
		expect(uniquePushes.size).toBe(1);
		const prCount = await ctx.sql`
			SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${featureId}
		`;
		expect(Number(prCount[0]?.n)).toBe(1);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("CI_RUNNING");

		// Re-drain must not create a second PR or second distinct push.
		await ctx.githubRuntime.processPendingHandoffs();
		const prCountAgain = await ctx.sql`
			SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${featureId}
		`;
		expect(Number(prCountAgain[0]?.n)).toBe(1);
		const uniquePushesAgain = new Set(
			ctx.gitState.pushes.map((p) => `${p.featureBranch}@${p.expectedHeadSha}`),
		);
		expect(uniquePushesAgain.size).toBe(1);
	});

	test("restart during GitHub polling preserves monotonic CI/review state", async () => {
		const token = await loginApi();
		const { attemptId, featureId } = await setupQueuedFeature(
			token,
			"Poll Restart",
			"poll-restart",
		);

		const outcomes = await ctx.drainDevelopmentWork();
		expect(outcomes.some((o) => o.kind === "completed" && o.attemptId === attemptId)).toBe(true);
		const handoff = await ctx.githubRuntime.processPendingHandoffs();
		expect(handoff.processed).toBeGreaterThanOrEqual(1);

		const prs = await ctx.sql`
			SELECT number, original_head_sha FROM pull_requests WHERE feature_id = ${featureId}
		`;
		expect(prs.length).toBe(1);
		const prNumber = Number(prs[0]?.number);
		const headSha = String(prs[0]?.original_head_sha ?? "feature-sha-1");
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("CI_RUNNING");

		// Block the status poll, start pollOnce, restart mid-poll, then release.
		ctx.holds.githubPoll.enable();
		ctx.clock.advanceMs(1_000);
		ctx.setPullRequestStatus(prNumber, {
			state: "open",
			currentHeadSha: headSha,
			checkSummary: "passing",
			reviewDecision: "REVIEW_REQUIRED",
			checks: [{ name: "ci", conclusion: "success", bucket: "pass", headSha }],
		});

		const pollPromise = ctx.githubRuntime.pollOnce();
		await ctx.holds.githubPoll.whenWaiting();

		const genBefore = ctx.lifecycleGeneration.github;
		await ctx.restartGithubRuntime();
		expect(ctx.lifecycleGeneration.github).toBe(genBefore + 1);

		// Disposed poll is abandoned (must not be awaited as success).
		void pollPromise;

		// Drive recreated runtime to apply the observation.
		ctx.clock.advanceMs(1_000);
		const polled = await ctx.githubRuntime.pollOnce();
		expect(polled).toBeGreaterThan(0);

		await waitUntil(async () => {
			const feature = await getFeatureById(ctx.sql, featureId);
			return feature?.state === "PR_REVIEW";
		}, "feature reaches PR_REVIEW after poll restart");

		// Monotonic: never regresses back to CI_RUNNING after PR_REVIEW.
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("PR_REVIEW");

		// A second poll with the same observation does not regress.
		ctx.clock.advanceMs(1_000);
		await ctx.githubRuntime.pollOnce();
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("PR_REVIEW");
	});

	test("cancelled attempt preserves evidence after API recreation", async () => {
		const token = await loginApi();
		const { projectId, featureId, attemptId } = await setupQueuedFeature(
			token,
			"Cancel Restart",
			"cancel-restart",
		);

		// Ensure no supervisor is running so cancel applies to a pure QUEUED attempt.
		await ctx.stopDevelopmentSupervisor();

		const cancelRes = await apiCall(token, "POST", `/api/features/${featureId}/cancel`, {
			projectId,
			featureId,
			reason: "User requested cancellation",
			operationKey: `cancel-${featureId}-1`,
			confirmation: "cancel-development",
		});
		expect(cancelRes.status).toBe(200);
		expect((await getDevelopmentAttempt(ctx.sql, attemptId))?.status).toBe("CANCELLED");

		await ctx.restartApi();
		const token2 = await loginApi();

		const attempt = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(attempt).not.toBeNull();
		// Cancelled queued work remains cancelled across API recreation.
		expect(attempt?.status).toBe("CANCELLED");

		const featureRes = await apiCall(token2, "GET", `/api/features/${featureId}`);
		expect(featureRes.status).toBe(200);

		const audit = await ctx.sql`
			SELECT action FROM audit_events
			WHERE feature_id = ${featureId}
			ORDER BY created_at
		`;
		expect(audit.length).toBeGreaterThan(0);
	});
});
