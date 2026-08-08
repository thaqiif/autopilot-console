/**
 * Concurrency and idempotency integration tests (requirement 43).
 *
 * Proves four projects run concurrently under production queue claims +
 * controllable worker ownership, a fifth waits until a slot opens, same-project
 * work never overlaps under a real claim race, duplicate approvals / retries /
 * cancellations / pushes / PR creates remain single, concurrent different
 * operation keys obey lifecycle rules, and stale feature versions / task
 * checksums / process observations / GitHub poll observations never overwrite
 * newer state.
 *
 * Uses real PostgreSQL with isolated state. No arbitrary sleeps — HoldGate and
 * bounded event waits drive synchronization. No direct SQL status='RUNNING'
 * simulation: claims flow through createDevelopmentQueue / DevelopmentWorker.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevelopmentWorker } from "../../apps/worker/src/development/development-worker";
import { createPostgresPrReconciliationStore } from "../../apps/worker/src/github/pr-reconciliation-store";
import { createRetryService } from "../../apps/worker/src/process/retry-service";
import {
	createDatabaseClient,
	createDevelopmentQueue,
	createOutboxIntent,
	createWorkerRegistration,
	getDevelopmentAttempt,
	getFeatureById,
	renewLease,
	updateAttemptStatus,
} from "../../packages/database/src/index";
import { applyFeatureTransition } from "../../packages/domain/src/index";
import {
	ADMIN_PASSWORD,
	ADMIN_USERNAME,
	bootstrapPhase1,
	DATABASE_URL,
	type Phase1Context,
	truncateAll,
} from "../fixtures/phase-1-seed";
import { waitUntil } from "../fixtures/wait-until";

let ctx: Phase1Context;
let tempDir: string;

const VALID_TASK = {
	name: "concurrency-test",
	description: "Concurrency test task",
	goals: ["Test concurrency"],
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
	csrfToken?: string,
): Promise<Response> {
	const headers: Record<string, string> = {
		Cookie: `ac_session=${token}`,
	};
	let jsonBody: string | undefined;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		jsonBody = JSON.stringify(body);
	}
	if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		headers["x-csrf-token"] = csrfToken ?? (await ctx.api.issueCsrf(token));
	}
	return ctx.api.app.request(path, { method, headers, body: jsonBody });
}

async function setupProjectWithFeature(
	token: string,
	name: string,
	slug: string,
): Promise<{ projectId: string; featureId: string; approvalChecksum: string }> {
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
		slug: `feat-${slug}`,
	});
	expect(featureRes.status).toBe(201);
	const featureBody = await featureRes.json();
	const featureId = featureBody.data.id as string;

	const taskPath = join(projectDir, "docs", "tasks", `${slug}.json`);
	await mkdir(join(projectDir, "docs", "tasks"), { recursive: true });
	await writeFile(taskPath, JSON.stringify(VALID_TASK, null, 2));

	const attachRes = await apiCall(token, "POST", `/api/features/${featureId}/task`, {
		relativeTaskPath: `docs/tasks/${slug}.json`,
	});
	expect(attachRes.status).toBe(200);
	const attachBody = await attachRes.json();
	const checksum = (attachBody.data?.approval?.checksum ?? attachBody.data?.checksum) as string;
	expect(typeof checksum).toBe("string");

	return { projectId, featureId, approvalChecksum: checksum };
}

async function approveQueue(
	token: string,
	setup: { projectId: string; featureId: string; approvalChecksum: string },
	operationKey: string,
	csrfToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await apiCall(
		token,
		"POST",
		`/api/features/${setup.featureId}/approve-queue`,
		{
			projectId: setup.projectId,
			featureId: setup.featureId,
			displayedChecksum: setup.approvalChecksum,
			operationKey,
			confirmation: "approve-and-queue",
		},
		csrfToken,
	);
	const body = (await res.json()) as Record<string, unknown>;
	return { status: res.status, body };
}

/** Production worker that claims through the real queue and holds on Autopilot wait. */
function createControllableWorker() {
	return createDevelopmentWorker({
		sql: ctx.sql,
		queue: ctx.queue,
		git: ctx.git,
		autopilot: ctx.autopilot,
		workerId: ctx.workerId,
		get workerRegistrationId() {
			return ctx.workerRegistrationId;
		},
		heartbeatScheduler: {
			async run(_intervalMs, heartbeat, task) {
				await heartbeat();
				return task();
			},
		},
		now: () => ctx.clock.now(),
	});
}

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "e2e-concurrency-"));
	ctx = await bootstrapPhase1({ workspaceRoot: tempDir, capacity: 4 });
});

afterAll(async () => {
	await ctx.stopDevelopmentSupervisor().catch(() => undefined);
	ctx.holds.autopilotWait.disable();
	ctx.holds.gitPush.disable();
	ctx.holds.createPr.disable();
	ctx.holds.githubPoll.disable();
	await ctx.client.end();
	await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	await ctx.stopDevelopmentSupervisor().catch(() => undefined);
	ctx.holds.autopilotWait.disable();
	ctx.holds.gitPush.disable();
	ctx.holds.createPr.disable();
	ctx.holds.githubPoll.disable();
	await truncateAll(ctx.sql);
	await ctx.api.bootstrapAdmin({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
	await ctx.ensureWorkerRegistration();
	ctx.resetExternalAdapterState();
});

describe("concurrency and idempotency (production queue + worker)", () => {
	test(
		"four controllable attempts from four projects run simultaneously and a fifth remains queued until a slot opens",
		async () => {
			const token = await loginApi();
			const setups = [];
			for (let i = 0; i < 5; i += 1) {
				const setup = await setupProjectWithFeature(token, `Capacity ${i}`, `cap-proj-${i}`);
				const { status, body } = await approveQueue(
					token,
					setup,
					`approve-${setup.featureId}-cap-${i}`,
				);
				expect(status).toBe(200);
				const data = body.data as { attempt: { id: string } };
				setups.push({ ...setup, attemptId: data.attempt.id });
			}

			const worker = createControllableWorker();
			ctx.holds.autopilotWait.enable();

			const started: Array<{ attemptId: string; finished: Promise<unknown> }> = [];
			for (let i = 0; i < 5; i += 1) {
				const begun = await worker.beginOnce();
				if (begun.kind === "started") {
					started.push({ attemptId: begun.attemptId, finished: begun.finished });
				}
			}

			// Capacity 4: four live claims, fifth claim rejected as idle.
			expect(started).toHaveLength(4);
			await waitUntil(
				async () => ctx.holds.autopilotWait.waitingCount() === 4,
				"four controllable Autopilot waits held",
			);

			const running = await ctx.sql`
				SELECT id, project_id, status FROM development_job_attempts WHERE status = ${"RUNNING"}
			`;
			expect(running).toHaveLength(4);
			expect(new Set(running.map((r) => r.project_id as string)).size).toBe(4);

			const queued = await ctx.sql`
				SELECT id, status FROM development_job_attempts WHERE status = ${"QUEUED"}
			`;
			expect(queued).toHaveLength(1);
			expect(queued[0]?.id).toBe(setups[4]?.attemptId);

			// Capacity still full — another claim returns idle.
			const stillFull = await worker.beginOnce();
			expect(stillFull.kind).toBe("idle");

			// Free all four slots by releasing the hold; then the fifth must claim.
			ctx.holds.autopilotWait.disable();
			await Promise.all(started.map((s) => s.finished));

			const fifth = await worker.beginOnce();
			expect(fifth.kind).toBe("started");
			expect(fifth.kind === "started" ? fifth.attemptId : null).toBe(setups[4]?.attemptId);
			if (fifth.kind === "started") await fifth.finished;

			const statuses = await ctx.sql`
				SELECT id, status FROM development_job_attempts ORDER BY enqueued_at ASC
			`;
			expect(statuses).toHaveLength(5);
			for (const row of statuses) {
				expect(row.status).toBe("SUCCEEDED");
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"two attempts for one project never own overlapping worker processes under a real claim race",
		async () => {
			const token = await loginApi();
			const setup = await setupProjectWithFeature(token, "Exclusion", "exclusion-proj");

			const first = await approveQueue(token, setup, `approve-${setup.featureId}-excl-a`);
			expect(first.status).toBe(200);
			const firstAttemptId = (first.body.data as { attempt: { id: string } }).attempt.id;

			// Claim first attempt through the production queue (not direct SQL).
			const claimed = await ctx.queue.claimNextAttempt(ctx.workerId);
			expect(claimed).not.toBeNull();
			expect(claimed?.attempt.id).toBe(firstAttemptId);
			expect(claimed?.attempt.status).toBe("RUNNING");

			const feature = await getFeatureById(ctx.sql, setup.featureId);
			const [approval] = await ctx.sql`
				SELECT id FROM task_approvals WHERE feature_id = ${setup.featureId} LIMIT 1
			`;
			const secondAttemptId = crypto.randomUUID();
			await ctx.sql`
				INSERT INTO development_job_attempts (
					id, project_id, feature_id, task_approval_id, branch_name, operation_key, status, enqueued_at
				) VALUES (
					${secondAttemptId},
					${setup.projectId},
					${setup.featureId},
					${approval?.id},
					${feature?.branchName ?? "feature/excl"},
					${`approve-${setup.featureId}-excl-b`},
					${"QUEUED"},
					now()
				)
			`;

			// Same worker: project exclusion must keep the second attempt unclaimed.
			const secondClaim = await ctx.queue.claimNextAttempt(ctx.workerId);
			expect(secondClaim).toBeNull();

			// Concurrent claim race with a second real DB client + worker registration.
			const client2 = createDatabaseClient(DATABASE_URL);
			try {
				const worker2Id = `race-worker-${crypto.randomUUID()}`;
				await createWorkerRegistration(client2.sql, {
					workerId: worker2Id,
					hostname: "race-host",
					capacity: 4,
				});
				const queue2 = createDevelopmentQueue(client2.sql, {
					maxConcurrent: 4,
					clock: () => ctx.clock.now(),
				});

				const [r1, r2] = await Promise.all([
					ctx.queue.claimNextAttempt(ctx.workerId),
					queue2.claimNextAttempt(worker2Id),
				]);
				const successes = [r1, r2].filter(Boolean);
				expect(successes).toHaveLength(0);

				const running = await ctx.sql`
					SELECT id FROM development_job_attempts
					WHERE project_id = ${setup.projectId} AND status = ${"RUNNING"}
				`;
				expect(running).toHaveLength(1);
				expect(running[0]?.id).toBe(firstAttemptId);

				const stillQueued = await ctx.sql`
					SELECT id FROM development_job_attempts
					WHERE id = ${secondAttemptId} AND status = ${"QUEUED"}
				`;
				expect(stillQueued).toHaveLength(1);
			} finally {
				await client2.end();
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"duplicate approvals, cancellations, development retries, pushes, and PR creates each return one durable outcome with one corresponding effect",
		async () => {
			const token = await loginApi();
			const setup = await setupProjectWithFeature(token, "Idempotent", "idempotent-proj");
			const opKey = `approve-${setup.featureId}-idempotent`;

			// ── Duplicate approvals ────────────────────────────────────────────
			const approve1 = await approveQueue(token, setup, opKey);
			expect(approve1.status).toBe(200);
			const attemptId1 = (approve1.body.data as { attempt: { id: string } }).attempt.id;

			const approve2 = await approveQueue(token, setup, opKey);
			expect(approve2.status).toBe(200);
			const data2 = approve2.body.data as { idempotent?: boolean; attempt: { id: string } };
			expect(data2.idempotent).toBe(true);
			expect(data2.attempt.id).toBe(attemptId1);

			const approvalAttempts = await ctx.sql`
				SELECT id FROM development_job_attempts WHERE feature_id = ${setup.featureId}
			`;
			expect(approvalAttempts).toHaveLength(1);
			const approvalIdempotency = await ctx.sql`
				SELECT id FROM idempotency_records WHERE operation_key = ${opKey}
			`;
			expect(approvalIdempotency).toHaveLength(1);

			// ── Duplicate cancellations (QUEUED) ───────────────────────────────
			const cancelKey = `cancel-${setup.featureId}-idempotent`;
			const cancelBody = {
				projectId: setup.projectId,
				featureId: setup.featureId,
				operationKey: cancelKey,
				reason: "owner requested cancel",
				confirmation: "cancel-development",
			};
			const cancel1 = await apiCall(
				token,
				"POST",
				`/api/features/${setup.featureId}/cancel`,
				cancelBody,
			);
			const cancel2 = await apiCall(
				token,
				"POST",
				`/api/features/${setup.featureId}/cancel`,
				cancelBody,
			);
			expect(cancel1.status).toBe(200);
			expect(cancel2.status).toBe(200);
			expect(await cancel1.json()).toEqual(await cancel2.json());

			const cancelAttempt = await getDevelopmentAttempt(ctx.sql, attemptId1);
			expect(cancelAttempt?.status).toBe("CANCELLED");
			const cancelCounts = await ctx.sql`
				SELECT
					(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${setup.featureId}) AS attempts,
					(SELECT count(*)::int FROM idempotency_records WHERE operation_key = ${cancelKey}) AS idempotency,
					(SELECT count(*)::int FROM activity_events
						WHERE feature_id = ${setup.featureId} AND type = ${"development.cancelled"}) AS activity,
					(SELECT count(*)::int FROM audit_events
						WHERE feature_id = ${setup.featureId} AND action = ${"development.cancel"}) AS audit
			`;
			expect(cancelCounts[0]).toMatchObject({
				attempts: 1,
				idempotency: 1,
				activity: 1,
				audit: 1,
			});

			// ── Duplicate development retries (production RetryService race) ───
			const [approvalRow] = await ctx.sql`
				SELECT id FROM task_approvals WHERE feature_id = ${setup.featureId} LIMIT 1
			`;
			const feature = await getFeatureById(ctx.sql, setup.featureId);
			expect(feature?.state).toBe("DEVELOPMENT_CANCELLED");
			const retryKey = `retry-${setup.featureId}-idempotent`;
			const retryRequest = {
				featureId: setup.featureId,
				projectId: setup.projectId,
				taskApprovalId: approvalRow?.id as string,
				branchName: feature?.branchName ?? "",
				operationKey: retryKey,
				reason: "operator retry",
				actorId: "test-admin",
			};
			const retryService = createRetryService({ sql: ctx.sql, now: () => ctx.clock.now() });
			const client2 = createDatabaseClient(DATABASE_URL);
			try {
				const retryService2 = createRetryService({
					sql: client2.sql,
					now: () => ctx.clock.now(),
				});
				const outcomes = await Promise.all([
					retryService.retry(retryRequest),
					retryService2.retry(retryRequest),
				]);
				expect(outcomes.map((o) => o.kind).sort()).toEqual(["idempotent", "retried"]);
				const attemptIds = outcomes.flatMap((o) => (o.kind === "blocked" ? [] : [o.attempt.id]));
				expect(new Set(attemptIds).size).toBe(1);

				const retryCounts = await ctx.sql`
					SELECT
						(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${setup.featureId}) AS attempts,
						(SELECT count(*)::int FROM idempotency_records WHERE operation_key = ${retryKey}) AS idempotency,
						(SELECT count(*)::int FROM activity_events
							WHERE feature_id = ${setup.featureId} AND type = ${"development.retried"}) AS activity,
						(SELECT count(*)::int FROM audit_events
							WHERE feature_id = ${setup.featureId} AND action = ${"development.retry"}) AS audit
				`;
				expect(retryCounts[0]).toMatchObject({
					attempts: 2,
					idempotency: 1,
					activity: 1,
					audit: 1,
				});
			} finally {
				await client2.end();
			}

			// ── Controllable worker completes the single retry attempt ─────────
			const worker = createControllableWorker();
			const begun = await worker.beginOnce();
			expect(begun.kind).toBe("started");
			if (begun.kind === "started") {
				const outcome = await begun.finished;
				expect(outcome.kind).toBe("completed");
			}
			const afterDev = await getFeatureById(ctx.sql, setup.featureId);
			expect(afterDev?.state).toBe("DEVELOPMENT_COMPLETE");

			// ── Duplicate push + PR create via production GitHub runtime ───────
			const handoff1 = await ctx.githubRuntime.processPendingHandoffs();
			const handoff2 = await ctx.githubRuntime.processPendingHandoffs();
			expect(handoff1.processed + handoff2.processed).toBeGreaterThanOrEqual(1);

			const prs = await ctx.sql`
				SELECT id, number FROM pull_requests WHERE feature_id = ${setup.featureId}
			`;
			expect(prs).toHaveLength(1);
			expect(ctx.githubState.prs.size).toBe(1);
			// Exactly one push effect for the feature branch.
			const pushes = ctx.gitState.pushes.filter((p) => p.featureBranch === afterDev?.branchName);
			expect(pushes).toHaveLength(1);
		},
		{ timeout: 30_000 },
	);

	test(
		"concurrent different operation keys obey lifecycle rules without partial or duplicate state",
		async () => {
			const token = await loginApi();
			const setup = await setupProjectWithFeature(token, "Concurrent Keys", "concurrent-keys");
			// Single CSRF token — concurrent issueCsrf would race the session binding.
			const csrf = await ctx.api.issueCsrf(token);

			const keyA = `approve-${setup.featureId}-key-a`;
			const keyB = `approve-${setup.featureId}-key-b`;

			const [resA, resB] = await Promise.all([
				approveQueue(token, setup, keyA, csrf),
				approveQueue(token, setup, keyB, csrf),
			]);

			const okCount = [resA, resB].filter((r) => r.status === 200).length;
			expect(okCount).toBeGreaterThanOrEqual(1);
			// The non-winner must not partially write a second attempt.
			for (const res of [resA, resB]) {
				expect([200, 409, 422]).toContain(res.status);
			}

			const attempts = await ctx.sql`
				SELECT id, operation_key, status FROM development_job_attempts
				WHERE feature_id = ${setup.featureId}
			`;
			expect(attempts).toHaveLength(1);

			const feature = await getFeatureById(ctx.sql, setup.featureId);
			expect(feature?.state).toBe("QUEUED");

			const idempotencyRows = await ctx.sql`
				SELECT operation_key FROM idempotency_records WHERE feature_id = ${setup.featureId}
			`;
			expect(idempotencyRows.length).toBeGreaterThanOrEqual(1);
			const successKeys = new Set(idempotencyRows.map((r) => r.operation_key as string));
			// Only one approval operation key may durable-succeed.
			const approvalKeys = [...successKeys].filter((k) => k === keyA || k === keyB);
			expect(approvalKeys).toHaveLength(1);
		},
		{ timeout: 30_000 },
	);

	test(
		"stale feature versions, task checksums, process observations, and GitHub poll observations cannot overwrite newer state",
		async () => {
			const token = await loginApi();
			const setup = await setupProjectWithFeature(token, "Stale Guard", "stale-guard");

			// ── Stale task checksum rejects approve ────────────────────────────
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
			expect([400, 409, 422]).toContain(staleChecksum.status);
			const notQueued = await getFeatureById(ctx.sql, setup.featureId);
			expect(notQueued?.state).not.toBe("QUEUED");
			const noAttempt = await ctx.sql`
				SELECT id FROM development_job_attempts WHERE feature_id = ${setup.featureId}
			`;
			expect(noAttempt).toHaveLength(0);

			// Approve with the real checksum.
			const ok = await approveQueue(token, setup, `approve-${setup.featureId}-fresh`);
			expect(ok.status).toBe(200);
			const attemptId = (ok.body.data as { attempt: { id: string } }).attempt.id;

			// ── Stale feature version cannot apply a transition ────────────────
			const feature = await getFeatureById(ctx.sql, setup.featureId);
			expect(feature).not.toBeNull();
			if (!feature) throw new Error("feature missing");
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

			// ── Stale process observation: prior worker cannot renew lease ─────
			const claimed = await ctx.queue.claimNextAttempt(ctx.workerId);
			expect(claimed?.attempt.id).toBe(attemptId);
			const ownerRegId = claimed?.attempt.workerRegistrationId;
			expect(ownerRegId).toBeTruthy();

			const newerWorker = await createWorkerRegistration(ctx.sql, {
				workerId: `newer-owner-${crypto.randomUUID()}`,
				hostname: "newer-host",
				capacity: 4,
			});
			// Newer owner takes the lease (reassignment).
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

			// ── Stale GitHub poll observation cannot overwrite newer head ──────
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
			// Replay an older observation timestamp after a newer write.
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
		},
		{ timeout: 30_000 },
	);
});
