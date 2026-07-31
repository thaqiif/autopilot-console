/**
 * Security boundary integration tests (requirement 44).
 *
 * Complete Phase 1 security matrix with:
 * - mandatory successful setup (no conditional branches that skip assertions)
 * - exact status + stable error codes (no broad not-success arrays)
 * - no-mutation / no-effect assertions on every rejection
 *
 * Uses real PostgreSQL, production-composition bootstrap, real temp directories
 * with symlinks, real CliGitGateway preflight, cancellation controller PID
 * reuse checks, PR reconciliation store monotonic observations, and shared
 * redaction.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCancellationController } from "../../apps/worker/src/process/cancellation-controller";
import { createPostgresPrReconciliationStore } from "../../apps/worker/src/github/pr-reconciliation-store";
import {
	createOutboxIntent,
	createWorkerRegistration,
	getDevelopmentAttempt,
	getFeatureById,
	renewLease,
	updateAttemptStatus,
} from "../../packages/database/src/index";
import { applyFeatureTransition } from "../../packages/domain/src/index";
import { CliGitGateway } from "../../packages/git/src/cli-git-gateway";
import {
	cleanupTempRoots,
	git,
	initTempRepository,
} from "../../packages/git/src/testing/temp-repository";
import { redactSecrets, redactValue } from "../../packages/shared/src/security/redaction";
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
	name: "security-test",
	description: "Security boundary task",
	goals: ["Prove security"],
	nonGoals: [],
	requirements: [
		{
			id: "1",
			description: "Req 1",
			acceptance: ["Criterion 1"],
			passes: false,
		},
	],
};

type JsonBody = {
	ok?: boolean;
	data?: Record<string, unknown>;
	error?: {
		code?: string;
		message?: string;
		httpStatus?: number;
		correlationId?: string;
		details?: Record<string, unknown>;
		nextAction?: string;
	};
};

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function loginApi(): Promise<string> {
	const loginResult = await ctx.api.directLogin({
		username: ADMIN_USERNAME,
		password: ADMIN_PASSWORD,
	});
	expect(loginResult.ok).toBe(true);
	if (!loginResult.ok) throw new Error("Login setup must succeed");
	return loginResult.token;
}

async function apiCall(
	token: string,
	method: string,
	path: string,
	body?: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: JsonBody; headers: Headers }> {
	const headers: Record<string, string> = {
		Cookie: `ac_session=${token}`,
		...extraHeaders,
	};
	let jsonBody: string | undefined;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		jsonBody = JSON.stringify(body);
	}
	if (
		["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
		headers["x-csrf-token"] === undefined &&
		!Object.hasOwn(extraHeaders, "x-csrf-token")
	) {
		headers["x-csrf-token"] = await ctx.api.issueCsrf(token);
	}
	const res = await ctx.api.app.request(path, { method, headers, body: jsonBody });
	let parsed: JsonBody = {};
	try {
		parsed = (await res.json()) as JsonBody;
	} catch {
		parsed = {};
	}
	return { status: res.status, body: parsed, headers: res.headers };
}

/** Setup that MUST succeed — never wrap assertions behind this. */
async function setupProjectWithFeature(
	token: string,
	name: string,
	slug: string,
): Promise<{
	projectId: string;
	featureId: string;
	releaseId: string;
	projectDir: string;
	approvalChecksum: string;
}> {
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
	expect(createRes.body.ok).toBe(true);
	const projectId = createRes.body.data?.id as string;
	expect(typeof projectId).toBe("string");

	const releaseRes = await apiCall(token, "POST", "/api/releases", {
		projectId,
		name: `v1-${slug}`,
		version: `1.0.0-${slug}`,
	});
	expect(releaseRes.status).toBe(201);
	const releaseId = releaseRes.body.data?.id as string;
	expect(typeof releaseId).toBe("string");

	const featureRes = await apiCall(token, "POST", "/api/features", {
		projectId,
		releaseId,
		title: `Feature ${name}`,
		slug: `feat-${slug}`,
	});
	expect(featureRes.status).toBe(201);
	const featureId = featureRes.body.data?.id as string;
	expect(typeof featureId).toBe("string");

	const taskPath = join(projectDir, "docs", "tasks", `${slug}.json`);
	await mkdir(join(projectDir, "docs", "tasks"), { recursive: true });
	await writeFile(taskPath, JSON.stringify(VALID_TASK, null, 2));

	const attachRes = await apiCall(token, "POST", `/api/features/${featureId}/task`, {
		relativeTaskPath: `docs/tasks/${slug}.json`,
	});
	expect(attachRes.status).toBe(200);
	const checksum = (attachRes.body.data?.approval as { checksum?: string } | undefined)?.checksum
		?? (attachRes.body.data?.checksum as string | undefined);
	expect(typeof checksum).toBe("string");

	return {
		projectId,
		featureId,
		releaseId,
		projectDir,
		approvalChecksum: checksum as string,
	};
}

async function countProjects(): Promise<number> {
	const rows = await ctx.sql`SELECT count(*)::int AS n FROM projects`;
	return Number(rows[0]?.n ?? -1);
}

async function countFeatures(): Promise<number> {
	const rows = await ctx.sql`SELECT count(*)::int AS n FROM features`;
	return Number(rows[0]?.n ?? -1);
}

async function countAttempts(featureId: string): Promise<number> {
	const rows = await ctx.sql`
		SELECT count(*)::int AS n FROM development_job_attempts WHERE feature_id = ${featureId}
	`;
	return Number(rows[0]?.n ?? -1);
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "e2e-security-"));
	ctx = await bootstrapPhase1({ workspaceRoot: tempDir });
});

afterAll(async () => {
	await cleanupTempRoots().catch(() => {});
	await ctx.client.end();
	await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	await truncateAll(ctx.sql);
	await ctx.api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
	await ctx.ensureWorkerRegistration();
	ctx.gitState.pushes.length = 0;
	ctx.gitState.preflightResults.clear();
	ctx.gitState.branches.clear();
	ctx.gitState.commits.clear();
	ctx.githubState.prs.clear();
	ctx.githubState.statuses.clear();
	ctx.githubState.accessResults.clear();
	ctx.githubState.nextPrNumber = 1;
});

describe("security boundaries — suite quality", () => {
	test("source contains no conditional setup skips or broad not-success status assertions", async () => {
		const source = await readFile(new URL(import.meta.url), "utf8");
		// Strip this self-check's string literals so the forbidden patterns do not match themselves.
		const body = source
			.replace(/describe\("security boundaries — suite quality"[\s\S]*?\n\}\);/, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(body).not.toMatch(/if\s*\(\s*\w*status\s*===\s*201\s*\)/);
		expect(body).not.toMatch(/if\s*\(\s*createRes\.status/);
		expect(body).not.toMatch(/expect\(\s*\[\s*400\s*,\s*401/);
		expect(body).not.toMatch(/expect\(\s*\[\s*400\s*,\s*409\s*,\s*422\s*\]/);
		expect(body).not.toMatch(/expect\(\s*\[\s*401\s*,\s*403\s*\]/);
		expect(body).not.toMatch(/\.not\.toBe\(\s*201\s*\)/);
		expect(body).not.toMatch(/\.not\.toBe\(\s*403\s*\)/);
	});
});

describe("security boundaries — workspace and task paths", () => {
	test("rejects workspace path outside allowlist with VALIDATION_FAILED and no mutation", async () => {
		const token = await loginApi();
		const before = await countProjects();

		const res = await apiCall(token, "POST", "/api/projects", {
			name: "Traversal Project",
			slug: "traversal-proj",
			githubOwner: "acme",
			githubRepo: "traversal",
			workspacePath: "/etc/passwd",
			developmentBranch: "main",
		});

		expect(res.status).toBe(400);
		expect(res.body.error?.code).toBe("VALIDATION_FAILED");
		expect(res.body.error?.httpStatus).toBe(400);
		expect(await countProjects()).toBe(before);
	});

	test("rejects symlink that escapes workspace root with VALIDATION_FAILED and no mutation", async () => {
		const token = await loginApi();
		const before = await countProjects();

		const realDir = join(tempDir, "real-project");
		await mkdir(realDir, { recursive: true });
		const symlinkDir = join(tempDir, "escape-link");
		await rm(symlinkDir, { recursive: true, force: true }).catch(() => {});
		await symlink("/tmp", symlinkDir);

		const res = await apiCall(token, "POST", "/api/projects", {
			name: "Symlink Project",
			slug: "symlink-proj",
			githubOwner: "acme",
			githubRepo: "symlink",
			workspacePath: symlinkDir,
			developmentBranch: "main",
		});

		expect(res.status).toBe(400);
		expect(res.body.error?.code).toBe("VALIDATION_FAILED");
		expect(await countProjects()).toBe(before);
	});

	test("rejects absolute and parent-traversal task paths with VALIDATION_FAILED and no task attach", async () => {
		const token = await loginApi();
		const setup = await setupProjectWithFeature(token, "Task Paths", "task-paths");
		const featuresBefore = await countFeatures();

		const traversal = await apiCall(token, "POST", `/api/features/${setup.featureId}/task`, {
			relativeTaskPath: "../../../etc/passwd.json",
		});
		expect(traversal.status).toBe(400);
		expect(traversal.body.error?.code).toBe("VALIDATION_FAILED");
		expect(traversal.body.error?.message).toMatch(/traversal|absolute|relative/i);

		const absolute = await apiCall(token, "POST", `/api/features/${setup.featureId}/task`, {
			relativeTaskPath: "/etc/passwd.json",
		});
		expect(absolute.status).toBe(400);
		expect(absolute.body.error?.code).toBe("VALIDATION_FAILED");
		expect(absolute.body.error?.message).toMatch(/absolute|relative/i);

		// Feature row remains; no second approval / no path change to the escape.
		const feature = await getFeatureById(ctx.sql, setup.featureId);
		expect(feature).not.toBeNull();
		expect(feature?.taskPath).not.toMatch(/\.\.|\/etc\//);
		expect(await countFeatures()).toBe(featuresBefore);
	});
});

describe("security boundaries — repository identity and dirty worktree", () => {
	test("rejects repository mismatch without leaking credentials and rejects unrelated dirty worktrees", async () => {
		const body = '{"requirements":[]}\n';
		const repo = await initTempRepository({
			initialFiles: {
				"README.md": "# fixture\n",
				"docs/tasks/demo.json": body,
			},
		});
		const gateway = new CliGitGateway();
		const expectedRepo = {
			owner: "acme",
			repository: "widget",
			fullName: "acme/widget",
		} as const;

		// Unrelated dirty path must fail preflight.
		await writeFile(join(repo.path, "unrelated.txt"), "dirty\n", "utf8");
		const dirty = await gateway.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
			taskRelativePath: "docs/tasks/demo.json",
			taskChecksum: sha256(body),
			allowTaskArtifactDirty: true,
		});
		expect(dirty.ok).toBe(false);
		expect(dirty.failures.some((f) => f.code === "DIRTY_WORKTREE")).toBe(true);

		// Credential-bearing remote must mismatch without leaking the secret.
		git(repo.path, [
			"remote",
			"set-url",
			"origin",
			"https://user:ghp_supersecrettoken1234567890abcd@github.com/other/repo.git",
		]);
		const mismatch = await gateway.preflight({
			projectRoot: repo.path,
			remoteName: "origin",
			expectedRepository: expectedRepo,
			developmentBranch: repo.developmentBranch,
			featureBranch: "feature/feat-1-demo",
		});
		expect(mismatch.ok).toBe(false);
		expect(mismatch.failures.some((f) => f.code === "REMOTE_IDENTITY_MISMATCH")).toBe(true);
		const blob = JSON.stringify(mismatch);
		expect(blob).not.toContain("ghp_supersecrettoken");
		expect(blob).not.toContain("user:ghp");
	});
});

describe("security boundaries — process and PR identity", () => {
	test("refuses signaling on PID reuse and blocks mismatched process identity", async () => {
		const token = await loginApi();
		const setup = await setupProjectWithFeature(token, "Pid Reuse", "pid-reuse");

		const approve = await apiCall(token, "POST", `/api/features/${setup.featureId}/approve-queue`, {
			projectId: setup.projectId,
			featureId: setup.featureId,
			displayedChecksum: setup.approvalChecksum,
			operationKey: `approve-${setup.featureId}`,
			confirmation: "approve-and-queue",
		});
		expect(approve.status).toBe(200);
		const attemptId = (approve.body.data?.attempt as { id: string }).id;
		expect(typeof attemptId).toBe("string");

		const claimed = await ctx.queue.claimNextAttempt(ctx.workerId);
		expect(claimed?.attempt.id).toBe(attemptId);

		await updateAttemptStatus(ctx.sql, attemptId, {
			status: "RUNNING",
			processPid: 4242,
			processStartIdentity: "1000",
			startedAt: ctx.clock.now(),
		});
		const attempt = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(attempt).not.toBeNull();
		if (!attempt) throw new Error("attempt must exist after setup");
		const feature = await getFeatureById(ctx.sql, setup.featureId);
		expect(feature).not.toBeNull();
		if (!feature) throw new Error("feature must exist after setup");

		const signals: Array<{ pid: number; kind: string }> = [];
		const tree = {
			async getDescendants() {
				return [] as number[];
			},
			async verifyIdentity() {
				return false;
			},
			async signal(pid: number, kind: "graceful" | "term" | "kill") {
				signals.push({ pid, kind });
			},
		};
		const controller = createCancellationController({
			sql: ctx.sql,
			tree,
			sleep: async () => {},
			now: () => ctx.clock.now(),
		});

		const blocked = await controller.cancelRunning(
			attempt,
			feature,
			{
				projectId: setup.projectId,
				featureId: setup.featureId,
				projectRoot: setup.projectDir,
				taskRelativePath: `docs/tasks/pid-reuse.json`,
				expectedBranch: "feature/pid-reuse",
				processIdentity: { pid: 4242, startTimeMs: 1000 },
				startedAt: ctx.clock.now().toISOString(),
			},
			"pid-reuse-probe",
			`cancel-pid-reuse:${attemptId}`,
		);
		expect(blocked.kind).toBe("blocked");
		expect(blocked.reason).toMatch(/PID reuse/i);
		expect(signals).toEqual([]);

		const after = await getDevelopmentAttempt(ctx.sql, attemptId);
		// Must not have been cancelled via signals; blocked path persists BLOCKED / interrupted style.
		expect(after?.status).not.toBe("CANCELLED");
		expect(signals).toHaveLength(0);
	});

	test("duplicate PR handoff reuses one PR identity with a single create effect", async () => {
		const token = await loginApi();
		const setup = await setupProjectWithFeature(token, "Pr Dup", "pr-dup");

		const approve = await apiCall(token, "POST", `/api/features/${setup.featureId}/approve-queue`, {
			projectId: setup.projectId,
			featureId: setup.featureId,
			displayedChecksum: setup.approvalChecksum,
			operationKey: `approve-pr-dup-${setup.featureId}`,
			confirmation: "approve-and-queue",
		});
		expect(approve.status).toBe(200);
		const attemptId = (approve.body.data?.attempt as { id: string }).id;

		const claimed = await ctx.queue.claimNextAttempt(ctx.workerId);
		expect(claimed?.attempt.id).toBe(attemptId);
		await updateAttemptStatus(ctx.sql, attemptId, {
			status: "SUCCEEDED",
			endedAt: ctx.clock.now(),
		});
		await ctx.sql`
			UPDATE features
			SET state = ${"DEVELOPMENT_COMPLETE"},
			    row_version = row_version + 1,
			    updated_at = now()
			WHERE id = ${setup.featureId}
		`;

		await createOutboxIntent(ctx.sql, {
			projectId: setup.projectId,
			featureId: setup.featureId,
			attemptId,
			kind: "create_pr",
			dedupeKey: `create_pr:${attemptId}`,
			payload: { attemptId },
		});

		await ctx.githubRuntime.processPendingHandoffs();
		expect(ctx.githubState.prs.size).toBe(1);
		const [pr1] = await ctx.sql`
			SELECT number FROM pull_requests WHERE feature_id = ${setup.featureId}
		`;
		expect(pr1?.number).toBeTruthy();

		// Replay handoff must not create a second durable PR identity.
		await createOutboxIntent(ctx.sql, {
			projectId: setup.projectId,
			featureId: setup.featureId,
			attemptId,
			kind: "create_pr",
			dedupeKey: `create_pr-retry:${attemptId}`,
			payload: { attemptId },
		});
		await ctx.githubRuntime.processPendingHandoffs();

		const prs = await ctx.sql`
			SELECT number FROM pull_requests WHERE feature_id = ${setup.featureId}
		`;
		expect(prs).toHaveLength(1);
		expect(prs[0]?.number).toBe(pr1?.number);
		expect(ctx.githubState.prs.size).toBe(1);
	});
});

describe("security boundaries — credential redaction", () => {
	test("redacts headers, cookies, URLs, tokens, nested values", () => {
		const auth = "Authorization: Bearer ghp_ABCDEFghijklmnop1234567890abcdef";
		expect(redactSecrets(auth)).not.toContain("ghp_ABCDEFghijklmnop1234567890abcdef");
		expect(redactSecrets(auth)).toContain("[REDACTED]");

		const cookie = "Cookie: session=abc123secretvalue; other=value";
		expect(redactSecrets(cookie)).not.toContain("abc123secretvalue");

		const pat = "github_pat_11ABCDEFGH01234567_abcdefghijklmnopqrstuvwxyz1234567890";
		expect(redactSecrets(pat)).not.toContain("github_pat_11ABCDEFGH01234567");

		const url = "https://user:secretpassword@github.com/org/repo.git";
		expect(redactSecrets(url)).not.toContain("secretpassword");
		expect(redactSecrets(url)).toContain("[REDACTED]");

		const nested = redactValue({
			name: "safe",
			config: { api_key: "secret123", password: "hunter2", safe_field: "visible" },
			credentials: { authorization: "Bearer token123" },
		}) as Record<string, unknown>;
		expect(nested.name).toBe("safe");
		expect((nested.config as Record<string, unknown>).api_key).toBe("[REDACTED]");
		expect((nested.config as Record<string, unknown>).password).toBe("[REDACTED]");
		expect((nested.config as Record<string, unknown>).safe_field).toBe("visible");
		expect((nested.credentials as Record<string, unknown>).authorization).toBe("[REDACTED]");
	});

	test("health, errors, activity, and audit never expose credentials", async () => {
		const token = await loginApi();
		const setup = await setupProjectWithFeature(token, "Redact Surfaces", "redact-surfaces");

		const health = await apiCall(token, "GET", "/api/health");
		expect(health.status).toBe(200);
		const healthBlob = JSON.stringify(health.body);
		expect(healthBlob).not.toMatch(/ghp_|github_pat_|password=|Bearer [A-Za-z0-9]/i);
		expect(healthBlob).not.toContain(ADMIN_PASSWORD);

		const unauth = await ctx.api.app.request("/api/projects", { method: "GET" });
		const errBody = await unauth.json();
		const errBlob = JSON.stringify(errBody);
		expect(errBlob).not.toContain("at Object.");
		expect(errBlob).not.toContain("node_modules");
		expect(errBlob).not.toContain(ADMIN_PASSWORD);
		expect(unauth.headers.get("x-correlation-id")).not.toBeNull();

		const activities = await ctx.sql`
			SELECT summary, metadata FROM activity_events
			WHERE project_id = ${setup.projectId}
		`;
		const activityBlob = JSON.stringify(activities);
		expect(activityBlob).not.toMatch(/ghp_|github_pat_|Bearer [A-Za-z0-9]{8,}/i);
		expect(activityBlob).not.toContain(ADMIN_PASSWORD);

		const audits = await ctx.sql`
			SELECT action, prior_values, next_values FROM audit_events
			WHERE project_id = ${setup.projectId}
		`;
		const auditBlob = JSON.stringify(audits);
		expect(auditBlob).not.toMatch(/ghp_|github_pat_|Bearer [A-Za-z0-9]{8,}/i);
		expect(auditBlob).not.toContain(ADMIN_PASSWORD);
	});
});

describe("security boundaries — session, CSRF, origin, cross-project", () => {
	test("missing, invalid, expired, and revoked sessions return 401 UNAUTHORIZED with no mutation", async () => {
		const before = await countProjects();

		const missing = await ctx.api.app.request("/api/projects", { method: "GET" });
		const missingBody = (await missing.json()) as JsonBody;
		expect(missing.status).toBe(401);
		expect(missingBody.error?.code).toBe("UNAUTHORIZED");

		const invalid = await ctx.api.app.request("/api/projects", {
			method: "GET",
			headers: { Cookie: "ac_session=invalid-token-that-does-not-exist" },
		});
		const invalidBody = (await invalid.json()) as JsonBody;
		expect(invalid.status).toBe(401);
		expect(invalidBody.error?.code).toBe("UNAUTHORIZED");

		const loginResult = await ctx.sessionService.login({
			username: ADMIN_USERNAME,
			password: ADMIN_PASSWORD,
		});
		expect(loginResult.ok).toBe(true);
		if (!loginResult.ok) throw new Error("login setup must succeed");
		const rawToken = loginResult.rawToken;
		const resolved = await ctx.sessionService.resolve({ rawToken });
		expect(resolved).not.toBeNull();

		ctx.clock.advanceMs(13 * 60 * 60 * 1000);
		const expiredResolve = await ctx.sessionService.resolve({ rawToken });
		expect(expiredResolve).toBeNull();
		const expiredApi = await ctx.api.app.request("/api/projects", {
			method: "GET",
			headers: { Cookie: `ac_session=${rawToken}` },
		});
		const expiredBody = (await expiredApi.json()) as JsonBody;
		expect(expiredApi.status).toBe(401);
		expect(expiredBody.error?.code).toBe("UNAUTHORIZED");

		// Fresh session then revoke.
		const fresh = await loginApi();
		await ctx.sessionService.logout({ rawToken: fresh });
		const revoked = await apiCall(fresh, "GET", "/api/projects");
		expect(revoked.status).toBe(401);
		expect(revoked.body.error?.code).toBe("UNAUTHORIZED");

		expect(await countProjects()).toBe(before);
	});

	test("missing and invalid CSRF and untrusted Origin return 403 FORBIDDEN with no mutation", async () => {
		const token = await loginApi();
		const before = await countProjects();
		const projectDir = join(tempDir, "csrf-target");
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(projectDir, ".git"), "");

		const payload = {
			name: "No CSRF",
			slug: "no-csrf",
			githubOwner: "acme",
			githubRepo: "no-csrf",
			workspacePath: projectDir,
			developmentBranch: "main",
		};

		const missingCsrf = await ctx.api.app.request("/api/projects", {
			method: "POST",
			headers: {
				Cookie: `ac_session=${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const missingBody = (await missingCsrf.json()) as JsonBody;
		expect(missingCsrf.status).toBe(403);
		expect(missingBody.error?.code).toBe("FORBIDDEN");

		const invalidCsrf = await ctx.api.app.request("/api/projects", {
			method: "POST",
			headers: {
				Cookie: `ac_session=${token}`,
				"Content-Type": "application/json",
				"x-csrf-token": "attacker-forged-csrf-token",
			},
			body: JSON.stringify({ ...payload, slug: "bad-csrf" }),
		});
		const invalidBody = (await invalidCsrf.json()) as JsonBody;
		expect(invalidCsrf.status).toBe(403);
		expect(invalidBody.error?.code).toBe("FORBIDDEN");

		const csrf = await ctx.api.issueCsrf(token);
		const badOrigin = await ctx.api.app.request("/api/projects", {
			method: "POST",
			headers: {
				Cookie: `ac_session=${token}`,
				"Content-Type": "application/json",
				"x-csrf-token": csrf,
				Origin: "https://attacker.example",
			},
			body: JSON.stringify({ ...payload, slug: "bad-origin" }),
		});
		const originBody = (await badOrigin.json()) as JsonBody;
		expect(badOrigin.status).toBe(403);
		expect(originBody.error?.code).toBe("FORBIDDEN");

		expect(await countProjects()).toBe(before);
	});

	test("cross-project mutation returns NOT_FOUND and leaves no feature row", async () => {
		const token = await loginApi();
		const a = await setupProjectWithFeature(token, "Project A", "proj-a");
		const b = await setupProjectWithFeature(token, "Project B", "proj-b");
		const beforeFeatures = await countFeatures();

		const cross = await apiCall(token, "POST", "/api/features", {
			projectId: a.projectId,
			releaseId: b.releaseId,
			title: "Cross Feature",
			slug: "cross-feature",
		});
		expect(cross.status).toBe(404);
		expect(cross.body.error?.code).toBe("NOT_FOUND");
		expect(await countFeatures()).toBe(beforeFeatures);
	});
});

describe("security boundaries — stale observations", () => {
	test("stale row version, checksum, process observation, and GitHub poll cannot overwrite newer state", async () => {
		const token = await loginApi();
		const setup = await setupProjectWithFeature(token, "Stale Guard", "stale-guard");

		// Stale checksum — exact CONFLICT, no attempt.
		const staleChecksum = await apiCall(
			token,
			"POST",
			`/api/features/${setup.featureId}/approve-queue`,
			{
				projectId: setup.projectId,
				featureId: setup.featureId,
				displayedChecksum: "sha256:stale-not-current",
				operationKey: `approve-${setup.featureId}-stale-checksum`,
				confirmation: "approve-and-queue",
			},
		);
		expect(staleChecksum.status).toBe(409);
		expect(staleChecksum.body.error?.code).toBe("CONFLICT");
		expect(await countAttempts(setup.featureId)).toBe(0);
		const notQueued = await getFeatureById(ctx.sql, setup.featureId);
		expect(notQueued?.state).not.toBe("QUEUED");

		// Fresh approve for subsequent stale probes.
		const ok = await apiCall(token, "POST", `/api/features/${setup.featureId}/approve-queue`, {
			projectId: setup.projectId,
			featureId: setup.featureId,
			displayedChecksum: setup.approvalChecksum,
			operationKey: `approve-${setup.featureId}-fresh`,
			confirmation: "approve-and-queue",
		});
		expect(ok.status).toBe(200);
		const attemptId = (ok.body.data?.attempt as { id: string }).id;

		// Stale feature row version — domain transition + SQL optimistic guard.
		const feature = await getFeatureById(ctx.sql, setup.featureId);
		expect(feature).not.toBeNull();
		if (!feature) throw new Error("feature must exist after approve setup");
		const staleTransition = applyFeatureTransition({
			featureId: setup.featureId,
			from: feature.state,
			to: "DEVELOPING",
			owner: "worker",
			cause: "stale version probe",
			operationId: `stale-version-${setup.featureId}`,
			expectedVersion: feature.rowVersion - 1,
			currentVersion: feature.rowVersion,
			observedState: feature.state,
		});
		expect(staleTransition.kind).toBe("rejected");

		const staleSql = await ctx.sql`
			UPDATE features
			SET state = ${"DEVELOPING"},
			    row_version = ${feature.rowVersion + 1},
			    updated_at = now()
			WHERE id = ${setup.featureId}
			  AND row_version = ${feature.rowVersion - 1}
			RETURNING id, state, row_version
		`;
		expect(staleSql).toHaveLength(0);
		const stillQueued = await getFeatureById(ctx.sql, setup.featureId);
		expect(stillQueued?.state).toBe("QUEUED");
		expect(stillQueued?.rowVersion).toBe(feature.rowVersion);

		// Stale process observation: prior worker cannot renew after reassignment.
		const claimed = await ctx.queue.claimNextAttempt(ctx.workerId);
		expect(claimed?.attempt.id).toBe(attemptId);
		const ownerRegId = claimed?.attempt.workerRegistrationId;
		expect(ownerRegId).toBeTruthy();

		const newerWorker = await createWorkerRegistration(ctx.sql, {
			workerId: `newer-owner-${crypto.randomUUID()}`,
			hostname: "newer-host",
			capacity: 4,
		});
		await updateAttemptStatus(ctx.sql, attemptId, {
			status: "RUNNING",
			workerRegistrationId: newerWorker.id,
		});
		await expect(
			renewLease(ctx.sql, {
				attemptId,
				workerRegistrationId: ownerRegId as string,
				leaseExpiresAt: new Date(ctx.clock.now().getTime() + 60_000),
			}),
		).rejects.toThrow(/lease renew denied/);
		const afterStaleRenew = await getDevelopmentAttempt(ctx.sql, attemptId);
		expect(afterStaleRenew?.workerRegistrationId).toBe(newerWorker.id);

		// Stale GitHub poll observation cannot overwrite newer head.
		await updateAttemptStatus(ctx.sql, attemptId, {
			status: "SUCCEEDED",
			endedAt: ctx.clock.now(),
		});
		await ctx.sql`
			UPDATE features
			SET state = ${"DEVELOPMENT_COMPLETE"},
			    row_version = row_version + 1,
			    updated_at = now()
			WHERE id = ${setup.featureId}
		`;
		await createOutboxIntent(ctx.sql, {
			projectId: setup.projectId,
			featureId: setup.featureId,
			attemptId,
			kind: "create_pr",
			dedupeKey: `create_pr:${attemptId}`,
			payload: { attemptId },
		});
		await ctx.githubRuntime.processPendingHandoffs();
		const [pr] = await ctx.sql`
			SELECT number FROM pull_requests WHERE feature_id = ${setup.featureId}
		`;
		expect(pr?.number).toBeTruthy();

		const store = createPostgresPrReconciliationStore({
			sql: ctx.sql,
			now: () => ctx.clock.now(),
		});
		const newerAt = ctx.clock.now();
		await store.updatePRObservation(setup.featureId, {
			observedHeadSha: "new-sha-head",
			observedState: "open",
			lastObservedAt: newerAt,
		});
		ctx.clock.advanceMs(60_000);
		const olderAt = new Date(newerAt.getTime() - 1);
		await store.updatePRObservation(setup.featureId, {
			observedHeadSha: "old-sha-head",
			observedState: "open",
			lastObservedAt: olderAt,
		});
		const observed = await ctx.sql`
			SELECT observed_head_sha, last_observed_at
			FROM pull_requests WHERE feature_id = ${setup.featureId}
		`;
		expect(observed[0]?.observed_head_sha).toBe("new-sha-head");
		expect(new Date(observed[0]?.last_observed_at as string | Date).getTime()).toBe(
			newerAt.getTime(),
		);
	});
});
