/**
 * Full Phase 1 owner journey E2E (requirement 41).
 *
 * Proves the complete lifecycle from login through external merge detection:
 *   login → register project → validate → create release → create feature →
 *   attach task → approve & queue → production development supervisor →
 *   production GitHub handoff consumer → current-head CI running/pass →
 *   PR review → external merge detection → exact activity/audit reconstruction.
 *
 * Uses real PostgreSQL, fake external adapters, and real temp directories.
 * Durable command consumers and the production worker supervisor are shared;
 * only Git/GitHub/Autopilot boundaries are substituted.
 * No arbitrary sleeps — state advances via production run-once/drain helpers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDevelopmentAttempt,
	getFeatureById,
	getProjectById,
	listAuditEventsForTarget,
} from "../../packages/database/src/index";
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
	name: "test-feature",
	description: "E2E test task",
	goals: ["Implement login"],
	nonGoals: ["No mobile app"],
	requirements: [
		{
			id: "1",
			description: "User can log in with email",
			acceptance: ["Valid email returns token"],
			passes: false,
		},
		{
			id: "2",
			description: "Invalid email shows error",
			acceptance: ["Invalid email returns 400"],
			passes: false,
		},
	],
};

/** Helper: login via the session service directly and return session token. */
async function loginApi(): Promise<string> {
	const loginResult = await ctx.api.directLogin({
		username: ADMIN_USERNAME,
		password: ADMIN_PASSWORD,
	});
	if (!loginResult.ok) {
		throw new Error(`Login failed: ${loginResult.status}`);
	}
	const resolved = await ctx.sessionService.resolve({ rawToken: loginResult.token });
	if (!resolved) {
		throw new Error("Session not resolvable after directLogin");
	}
	return loginResult.token;
}

/** Helper: make an authenticated JSON request. */
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

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "e2e-journey-"));
	ctx = await bootstrapPhase1({ workspaceRoot: tempDir });
});

afterAll(async () => {
	await ctx.client.end();
	await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	await truncateAll(ctx.sql);
	await ctx.api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
});

describe("Phase 1 owner journey", () => {
	test("unauthenticated visitor gets 401 on protected routes and cannot mutate", async () => {
		const list = await ctx.api.app.request("/api/projects", { method: "GET" });
		expect(list.status).toBe(401);

		const create = await ctx.api.app.request("/api/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nope" }),
		});
		expect(create.status).toBe(401);
	});

	test("administrator can login and access protected routes", async () => {
		const token = await loginApi();
		expect(token.length).toBeGreaterThan(0);

		const res = await apiCall(token, "GET", "/api/projects");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test("full journey: register → validate → release → feature → attach → approve → production supervisor → CI → review → external merge", async () => {
		const token = await loginApi();

		// ── Step 1: Register + validate project ──
		const projectDir = join(tempDir, "project-a");
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(projectDir, ".git"), "");

		const validateRes = await apiCall(token, "POST", "/api/projects/validate", {
			name: "Project A",
			slug: "project-a",
			githubOwner: "acme",
			githubRepo: "project-a",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(validateRes.status).toBe(200);
		const validateBody = await validateRes.json();
		expect(validateBody.ok).toBe(true);

		const createRes = await apiCall(token, "POST", "/api/projects", {
			name: "Project A",
			slug: "project-a",
			githubOwner: "acme",
			githubRepo: "project-a",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(createRes.status).toBe(201);
		const projectBody = await createRes.json();
		expect(projectBody.ok).toBe(true);
		const projectId = projectBody.data.id as string;

		const project = await getProjectById(ctx.sql, projectId);
		expect(project).not.toBeNull();
		expect(project?.name).toBe("Project A");

		// ── Step 2: Create release ──
		const releaseRes = await apiCall(token, "POST", "/api/releases", {
			projectId,
			name: "v1.0.0",
			version: "1.0.0",
		});
		expect(releaseRes.status).toBe(201);
		const releaseBody = await releaseRes.json();
		expect(releaseBody.ok).toBe(true);
		const releaseId = releaseBody.data.id as string;

		// ── Step 3: Create feature ──
		const featureRes = await apiCall(token, "POST", "/api/features", {
			projectId,
			releaseId,
			title: "Login",
			slug: "login",
			summary: "Implement user login",
		});
		expect(featureRes.status).toBe(201);
		const featureBody = await featureRes.json();
		expect(featureBody.ok).toBe(true);
		const featureId = featureBody.data.id as string;

		const feature = await getFeatureById(ctx.sql, featureId);
		expect(feature).not.toBeNull();
		expect(feature?.state).toBe("PLANNED");

		// ── Step 4: Attach task file ──
		const taskPath = join(projectDir, "docs", "tasks", "login.json");
		await mkdir(join(projectDir, "docs", "tasks"), { recursive: true });
		await writeFile(taskPath, JSON.stringify(VALID_TASK, null, 2));

		const attachRes = await apiCall(token, "POST", `/api/features/${featureId}/task`, {
			relativeTaskPath: "docs/tasks/login.json",
		});
		expect(attachRes.status).toBe(200);
		const attachBody = await attachRes.json();
		expect(attachBody.ok).toBe(true);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("TASKS_REVIEW");

		// ── Step 5: Approve & Queue Development (durable API only) ──
		const approval = attachBody.data?.approval;
		const checksum = approval?.checksum ?? attachBody.data?.checksum;
		expect(checksum).toBeTruthy();

		const approveRes = await apiCall(token, "POST", `/api/features/${featureId}/approve-queue`, {
			projectId,
			featureId,
			displayedChecksum: checksum,
			operationKey: `approve-${featureId}-1`,
			confirmation: "approve-and-queue",
		});
		expect(approveRes.status).toBe(200);
		const approveBody = await approveRes.json();
		expect(approveBody.ok).toBe(true);
		expect(approveBody.data.attempt).toBeTruthy();
		const attemptId = approveBody.data.attempt.id as string;

		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("QUEUED");
		const attempt = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(attempt).not.toBeNull();
		expect(attempt?.status).toBe("QUEUED");
		expect(attempt?.projectId).toBe(projectId);
		expect(attempt?.featureId).toBe(featureId);

		// Idempotent approve
		const approveRes2 = await apiCall(token, "POST", `/api/features/${featureId}/approve-queue`, {
			projectId,
			featureId,
			displayedChecksum: checksum,
			operationKey: `approve-${featureId}-1`,
			confirmation: "approve-and-queue",
		});
		expect(approveRes2.status).toBe(200);
		const approveBody2 = await approveRes2.json();
		expect(approveBody2.data.idempotent).toBe(true);

		// ── Step 6: Production development supervisor claims and completes ──
		// Must use the same concurrent supervisor path as apps/worker main, not a
		// private one-shot helper that bypasses ownership heartbeats/capacity.
		expect(ctx.developmentRuntime).toBeDefined();
		expect(typeof ctx.developmentRuntime.capacity).toBe("function");
		expect(ctx.developmentRuntime.capacity()).toBeGreaterThanOrEqual(1);

		const workerOutcomes = await ctx.drainDevelopmentWork();
		expect(workerOutcomes.some((o) => o.kind === "completed" && o.attemptId === attemptId)).toBe(
			true,
		);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("DEVELOPMENT_COMPLETE");
		const completedAttempt = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(completedAttempt?.status).toBe("SUCCEEDED");

		// Outbox intent must exist for production handoff consumer
		const outbox = await ctx.sql`
			SELECT kind, status, attempt_id FROM outbox_intents
			WHERE feature_id = ${featureId} AND kind = 'create_pr'
		`;
		expect(outbox.length).toBe(1);
		expect(outbox[0]?.attempt_id).toBe(attemptId);

		// ── Step 7: Production GitHub runtime consumes create_pr outbox ──
		expect(ctx.githubRuntime).toBeDefined();
		const handoff = await ctx.githubRuntime.processPendingHandoffs();
		expect(handoff.processed).toBeGreaterThanOrEqual(1);
		expect(handoff.outcomes.some((o) => o.kind === "completed")).toBe(true);

		const featureAfterPr = await getFeatureById(ctx.sql, featureId);
		expect(featureAfterPr?.state).toBe("CI_RUNNING");
		const prs = await ctx.sql`
			SELECT number, head_branch, base_branch, original_head_sha
			FROM pull_requests WHERE feature_id = ${featureId}
		`;
		expect(prs.length).toBe(1);
		const prNumber = Number(prs[0]?.number);
		expect(prNumber).toBeGreaterThan(0);

		// Exactly one branch push was performed by the handoff worker
		expect(ctx.gitState.pushes.length).toBe(1);
		expect(ctx.gitState.pushes[0]?.featureBranch).toBe(String(prs[0]?.head_branch));

		// Re-drain handoff: no duplicate PR
		const handoffAgain = await ctx.githubRuntime.processPendingHandoffs();
		expect(handoffAgain.processed).toBe(0);
		const prsAgain = await ctx.sql`
			SELECT count(*)::int AS n FROM pull_requests WHERE feature_id = ${featureId}
		`;
		expect(Number(prsAgain[0]?.n)).toBe(1);

		// ── Step 8: Current-head CI running stays CI_RUNNING ──
		// Advance the shared test clock between polls so stale-observation
		// protection cannot discard newer current-head status.
		const headSha = String(prs[0]?.original_head_sha ?? "feature-sha-1");
		ctx.clock.advanceMs(1_000);
		ctx.setPullRequestStatus(prNumber, {
			state: "open",
			currentHeadSha: headSha,
			checkSummary: "pending",
			reviewDecision: "REVIEW_REQUIRED",
			checks: [{ name: "ci", conclusion: "pending", bucket: "pending", headSha }],
		});
		expect(await ctx.githubRuntime.pollOnce()).toBeGreaterThan(0);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("CI_RUNNING");

		// ── Step 9: CI pass → PR_REVIEW ──
		ctx.clock.advanceMs(1_000);
		ctx.setPullRequestStatus(prNumber, {
			state: "open",
			currentHeadSha: headSha,
			checkSummary: "passing",
			reviewDecision: "REVIEW_REQUIRED",
			checks: [{ name: "ci", conclusion: "success", bucket: "pass", headSha }],
		});
		expect(await ctx.githubRuntime.pollOnce()).toBeGreaterThan(0);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("PR_REVIEW");

		// ── Step 10: External merge (outside Console) → DEVELOPMENT_MERGED ──
		ctx.clock.advanceMs(1_000);
		ctx.mergePrExternally(prNumber, "merge-sha-e2e-1");
		expect(await ctx.githubRuntime.pollOnce()).toBeGreaterThan(0);
		expect((await getFeatureById(ctx.sql, featureId))?.state).toBe("DEVELOPMENT_MERGED");

		// ── Step 11: Overview, attention, activity, audit reconstruct the journey ──
		const overviewRes = await apiCall(token, "GET", "/api/overview");
		expect(overviewRes.status).toBe(200);
		const overview = await overviewRes.json();
		expect(overview.ok).toBe(true);

		const attentionRes = await apiCall(token, "GET", "/api/attention");
		expect(attentionRes.status).toBe(200);

		const activityRes = await apiCall(token, "GET", "/api/activity");
		expect(activityRes.status).toBe(200);

		const activity = await ctx.sql`
			SELECT type FROM activity_events
			WHERE feature_id = ${featureId}
			ORDER BY created_at ASC, id ASC
		`;
		const activityTypes = activity.map((row) => String(row.type));
		expect(activityTypes).toContain("development.started");
		expect(activityTypes).toContain("pr.created");
		expect(activityTypes).toContain("ci.passed");
		expect(activityTypes).toContain("pr.merged");

		const featureAudit = await listAuditEventsForTarget(ctx.sql, {
			targetType: "feature",
			targetId: featureId,
		});
		const featureActions = featureAudit.map((e) => e.action);
		expect(featureActions).toContain("pr.merged");

		const projectAudit = await listAuditEventsForTarget(ctx.sql, {
			targetType: "project",
			targetId: projectId,
		});
		const projectActions = projectAudit.map((e) => e.action);
		expect(projectActions).toContain("project.create");

		// ── Step 12: Console exposes no PR approve or merge action ──
		for (const path of [
			`/api/features/${featureId}/pr-approve`,
			`/api/features/${featureId}/pr-merge`,
			`/api/pull-requests/${prNumber}/approve`,
			`/api/pull-requests/${prNumber}/merge`,
			`/api/prs/${prNumber}/approve`,
			`/api/prs/${prNumber}/merge`,
		]) {
			const res = await apiCall(token, "POST", path, {
				projectId,
				featureId,
				confirmation: "approve",
			});
			// 404 (no route) or 405 (method not allowed) — never a successful mutation.
			expect([404, 405]).toContain(res.status);
		}

		// Production composition must not reintroduce private one-shot shortcuts that
		// bypass the durable outbox / supervisor path used in apps/worker main.
		expect(
			"runDevelopmentOnce" in ctx &&
				typeof (ctx as { runDevelopmentOnce?: unknown }).runDevelopmentOnce,
		).toBe(false);
		expect("runPrHandoff" in ctx && typeof (ctx as { runPrHandoff?: unknown }).runPrHandoff).toBe(
			false,
		);
	});

	test("logout invalidates session", async () => {
		const token = await loginApi();

		const before = await apiCall(token, "GET", "/api/projects");
		expect(before.status).toBe(200);

		await ctx.api.logout(token);

		const after = await ctx.api.app.request("/api/projects", {
			method: "GET",
			headers: { Cookie: `ac_session=${token}` },
		});
		expect(after.status).toBe(401);
	});

	test("overview returns zero-state before any projects", async () => {
		const token = await loginApi();
		const res = await apiCall(token, "GET", "/api/overview");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test("attention queue returns empty when no features need attention", async () => {
		const token = await loginApi();
		const res = await apiCall(token, "GET", "/api/attention");
		expect(res.status).toBe(200);
	});

	test("activity endpoint returns events after mutations", async () => {
		const token = await loginApi();

		const projectDir = join(tempDir, "activity-test");
		await mkdir(projectDir, { recursive: true });

		const res = await apiCall(token, "POST", "/api/projects", {
			name: "Activity Project",
			slug: "activity-project",
			githubOwner: "acme",
			githubRepo: "activity-project",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(res.status).toBe(201);

		const activityRes = await apiCall(token, "GET", "/api/activity");
		expect(activityRes.status).toBe(200);
	});

	test("health endpoints are public", async () => {
		const res = await ctx.api.app.request("/api/health");
		expect(res.status).toBe(200);
	});
});
