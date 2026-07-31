import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AutopilotRunHandle, SignalKind } from "../../../../packages/autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createAdminAccount,
	createDatabaseClient,
	createDevelopmentAttempt,
	createFeature,
	createProject,
	createRelease,
	createTaskApproval,
	createWorkerRegistration,
	createWorkspace,
	type DatabaseClient,
	getDevelopmentAttempt,
	getFeatureById,
	type Sql,
	updateAttemptStatus,
} from "../../../../packages/database/src/index";
import {
	createCancellationController,
	type ProcessTreeInspector,
} from "../process/cancellation-controller";
import { createProcessTreeInspector } from "../process/process-tree";
import { createRetryService } from "../process/retry-service";
import { createJobCommandWorker, type JobCommandWorker } from "./job-command-worker";
import { reconcileOrphansAtWorkerStartup } from "./startup-reconciliation";

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

interface SignalRecord {
	pid: number;
	kind: SignalKind;
}

function createFakeTree(options?: {
	identityOk?: boolean | (() => boolean);
	descendants?: number[];
	onSignal?: (pid: number, kind: SignalKind) => void;
}): ProcessTreeInspector & { signals: SignalRecord[] } {
	const signals: SignalRecord[] = [];
	return {
		signals,
		async getDescendants() {
			return [...(options?.descendants ?? [])];
		},
		async verifyIdentity() {
			const value = options?.identityOk;
			if (typeof value === "function") return value();
			return value ?? true;
		},
		async signal(pid, kind) {
			signals.push({ pid, kind });
			options?.onSignal?.(pid, kind);
		},
	};
}

interface SeededRunning {
	attemptId: string;
	featureId: string;
	projectId: string;
	approvalId: string;
	adminId: string;
	branchName: string;
	workerRegistrationId: string;
	workerId: string;
	pid: number;
	startTimeMs: number;
}

async function seedOwnedCancelRequested(options?: {
	workerId?: string;
	status?: "RUNNING" | "CANCEL_REQUESTED";
	processPid?: number | null;
	processStartIdentity?: string | null;
	leaseExpired?: boolean;
}): Promise<SeededRunning> {
	const workerId = options?.workerId ?? `worker-${crypto.randomUUID()}`;
	const registration = await createWorkerRegistration(sql, {
		workerId,
		hostname: "test-host",
		capacity: 4,
	});
	const workspace = await createWorkspace(sql);
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID()}`,
		passwordHash: "hash",
	});
	const suffix = crypto.randomUUID();
	const project = await createProject(sql, {
		workspaceId: workspace.id,
		name: `Cmd Project ${suffix}`,
		slug: `cmd-${suffix}`,
		githubOwner: "acme",
		githubRepo: `cmd-${suffix}`,
		canonicalPath: `/workspaces/cmd-${suffix}`,
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
		state: "DEVELOPING",
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/login.json",
		checksum: `sha256:${suffix}`,
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [{ id: "1", passes: false }] },
		approvedByAdminId: admin.id,
	});
	const pid = options?.processPid === undefined ? 4242 : options.processPid;
	const startTimeMs = 1_700_000_000_000;
	const status = options?.status ?? "CANCEL_REQUESTED";
	const attempt = await createDevelopmentAttempt(sql, {
		projectId: project.id,
		featureId: feature.id,
		taskApprovalId: approval.id,
		branchName,
		operationKey: `develop:${suffix}`,
		status: "RUNNING",
		workerRegistrationId: registration.id,
		processPid: pid ?? undefined,
		processStartIdentity:
			options?.processStartIdentity === undefined
				? String(startTimeMs)
				: (options.processStartIdentity ?? undefined),
		leaseExpiresAt: options?.leaseExpired
			? new Date(Date.now() - 60_000)
			: new Date(Date.now() + 60_000),
		heartbeatAt: new Date(),
	});
	if (status === "CANCEL_REQUESTED") {
		await updateAttemptStatus(sql, attempt.id, {
			status: "CANCEL_REQUESTED",
			cancellationRequestedAt: new Date(),
			cancellationReason: "owner requested stop",
		});
	} else {
		await updateAttemptStatus(sql, attempt.id, { status: "RUNNING" });
	}
	const refreshed = await getDevelopmentAttempt(sql, attempt.id);
	if (!refreshed) throw new Error("seed failed");
	return {
		attemptId: refreshed.id,
		featureId: feature.id,
		projectId: project.id,
		approvalId: approval.id,
		adminId: admin.id,
		branchName,
		workerRegistrationId: registration.id,
		workerId,
		pid: pid ?? 0,
		startTimeMs,
	};
}

async function seedFailedForRetry(options?: {
	alivePid?: number | null;
	aliveStart?: string | null;
}): Promise<{
	featureId: string;
	projectId: string;
	approvalId: string;
	adminId: string;
	branchName: string;
	failedAttemptId: string;
}> {
	const workspace = await createWorkspace(sql);
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID()}`,
		passwordHash: "hash",
	});
	const suffix = crypto.randomUUID();
	const project = await createProject(sql, {
		workspaceId: workspace.id,
		name: `Retry Project ${suffix}`,
		slug: `retry-${suffix}`,
		githubOwner: "acme",
		githubRepo: `retry-${suffix}`,
		canonicalPath: `/workspaces/retry-${suffix}`,
		developmentBranch: "main",
	});
	const release = await createRelease(sql, {
		projectId: project.id,
		name: "r1",
		version: "1.0.0",
		sortOrder: 1,
	});
	const branchName = `feature/${suffix}-retry`;
	const feature = await createFeature(sql, {
		projectId: project.id,
		releaseId: release.id,
		slug: `retry-${suffix}`,
		title: "Retry",
		branchName,
		state: "DEVELOPMENT_FAILED",
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/retry.json",
		checksum: `sha256:${suffix}`,
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [{ id: "1", passes: true }] },
		approvedByAdminId: admin.id,
	});
	const failed = await createDevelopmentAttempt(sql, {
		projectId: project.id,
		featureId: feature.id,
		taskApprovalId: approval.id,
		branchName,
		operationKey: `develop:${suffix}`,
		status: "FAILED",
		processPid: options?.alivePid === undefined ? undefined : (options.alivePid ?? undefined),
		processStartIdentity:
			options?.aliveStart === undefined ? undefined : (options.aliveStart ?? undefined),
	});
	return {
		featureId: feature.id,
		projectId: project.id,
		approvalId: approval.id,
		adminId: admin.id,
		branchName,
		failedAttemptId: failed.id,
	};
}

function composeWorker(input: {
	workerId: string;
	workerRegistrationId: string;
	tree: ProcessTreeInspector;
}): JobCommandWorker {
	const cancellation = createCancellationController({
		sql,
		tree: input.tree,
		graceMs: 1,
		killGraceMs: 1,
		sleep: async () => {},
	});
	const retry = createRetryService({
		sql,
		autopilot: {
			async isAlive(handle: AutopilotRunHandle) {
				return input.tree.verifyIdentity(
					handle.processIdentity.pid,
					handle.processIdentity.startTimeMs,
				);
			},
		} as never,
	});
	return createJobCommandWorker({
		sql,
		workerId: input.workerId,
		workerRegistrationId: input.workerRegistrationId,
		cancellation,
		retry,
		tree: input.tree,
		reconcileOrphans: () => reconcileOrphansAtWorkerStartup(sql, { now: () => new Date() }),
		pollIntervalMs: 10,
		sleep: async () => {},
	});
}

beforeAll(async () => {
	adminClient = createDatabaseClient(ADMIN_DATABASE_URL);
	databaseName = `job_cmd_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
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
			activity_events,
			audit_events,
			failure_records,
			progress_snapshots,
			diagnostic_log_chunks,
			development_job_attempts,
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

describe("job-command worker composition", () => {
	test("consumes durable CANCEL_REQUESTED owned by this worker and escalates signals", async () => {
		const seed = await seedOwnedCancelRequested();
		const tree = createFakeTree({ identityOk: true, descendants: [5001] });
		const worker = composeWorker({
			workerId: seed.workerId,
			workerRegistrationId: seed.workerRegistrationId,
			tree,
		});

		const first = await worker.processPendingCancels();
		expect(first.cancelsProcessed).toBe(1);
		expect(first.outcomes[0]?.outcome.kind).toBe("cancelled");

		const attempt = await getDevelopmentAttempt(sql, seed.attemptId);
		const feature = await getFeatureById(sql, seed.featureId);
		expect(attempt?.status).toBe("CANCELLED");
		expect(feature?.state).toBe("DEVELOPMENT_CANCELLED");
		expect(attempt?.cancellationReason).toBe("owner requested stop");

		const kinds = tree.signals.map((s) => s.kind);
		expect(kinds).toContain("graceful");
		expect(kinds).toContain("term");
		expect(kinds).toContain("kill");
		expect(tree.signals.some((s) => s.pid === 5001 && s.kind === "term")).toBe(true);

		const [evidence] = await sql`
			SELECT
				(SELECT count(*)::int FROM activity_events
					WHERE attempt_id = ${seed.attemptId}
						AND type IN ('development.cancelled', 'development.cancel_requested')) AS activity,
				(SELECT count(*)::int FROM audit_events
					WHERE attempt_id = ${seed.attemptId}
						AND action IN ('development.cancel', 'development.cancel_request')) AS audit,
				(SELECT structured_result IS NOT NULL FROM development_job_attempts WHERE id = ${seed.attemptId}) AS has_structured
		`;
		expect(Number(evidence?.activity ?? 0)).toBeGreaterThanOrEqual(1);
		expect(Number(evidence?.audit ?? 0)).toBeGreaterThanOrEqual(1);

		// Duplicate poll is a no-op (idempotent)
		const second = await worker.processPendingCancels();
		expect(second.cancelsProcessed).toBe(0);
		expect(tree.signals.filter((s) => s.kind === "graceful")).toHaveLength(1);
	});

	test("ignores CANCEL_REQUESTED owned by a different worker", async () => {
		const seed = await seedOwnedCancelRequested({ workerId: "owner-a" });
		const otherRegistration = await createWorkerRegistration(sql, {
			workerId: "owner-b",
			hostname: "other",
			capacity: 2,
		});
		const tree = createFakeTree();
		const worker = composeWorker({
			workerId: "owner-b",
			workerRegistrationId: otherRegistration.id,
			tree,
		});
		const result = await worker.processPendingCancels();
		expect(result.cancelsProcessed).toBe(0);
		expect(tree.signals).toHaveLength(0);
		const attempt = await getDevelopmentAttempt(sql, seed.attemptId);
		expect(attempt?.status).toBe("CANCEL_REQUESTED");
	});

	test("does not signal when PID identity is reused and records a safe block", async () => {
		const seed = await seedOwnedCancelRequested();
		const tree = createFakeTree({ identityOk: false });
		const worker = composeWorker({
			workerId: seed.workerId,
			workerRegistrationId: seed.workerRegistrationId,
			tree,
		});
		const result = await worker.processPendingCancels();
		expect(result.cancelsProcessed).toBe(1);
		expect(result.outcomes[0]?.outcome.kind).toBe("blocked");
		expect(tree.signals).toHaveLength(0);
		const attempt = await getDevelopmentAttempt(sql, seed.attemptId);
		const feature = await getFeatureById(sql, seed.featureId);
		expect(attempt?.status).toBe("FAILED");
		expect(feature?.state).toBe("BLOCKED");
	});

	test("skips escalate when process exits after graceful stop", async () => {
		const seed = await seedOwnedCancelRequested();
		let checks = 0;
		const tree = createFakeTree({
			identityOk: () => {
				checks += 1;
				return checks === 1; // first verify ok, then gone after grace
			},
		});
		const worker = composeWorker({
			workerId: seed.workerId,
			workerRegistrationId: seed.workerRegistrationId,
			tree,
		});
		await worker.processPendingCancels();
		expect(tree.signals.every((s) => s.kind === "graceful")).toBe(true);
		const attempt = await getDevelopmentAttempt(sql, seed.attemptId);
		expect(attempt?.status).toBe("CANCELLED");
	});

	test("retry refuses while a verified related process is alive", async () => {
		const seed = await seedFailedForRetry({
			alivePid: 9991,
			aliveStart: "12345",
		});
		const tree = createFakeTree({ identityOk: true });
		const registration = await createWorkerRegistration(sql, {
			workerId: `retry-worker-${crypto.randomUUID()}`,
			hostname: "retry-host",
			capacity: 1,
		});
		const worker = composeWorker({
			workerId: "retry-owner",
			workerRegistrationId: registration.id,
			tree,
		});
		const outcome = await worker.retry({
			featureId: seed.featureId,
			projectId: seed.projectId,
			taskApprovalId: seed.approvalId,
			branchName: seed.branchName,
			operationKey: `retry:${seed.failedAttemptId}`,
			reason: "try again",
			actorId: seed.adminId,
		});
		expect(outcome.kind).toBe("blocked");
		const [count] = await sql`
			SELECT count(*)::int AS n FROM development_job_attempts WHERE feature_id = ${seed.featureId}
		`;
		expect(count?.n).toBe(1);
	});

	test("retry creates one distinct successor attempt after verified exit and is idempotent", async () => {
		const seed = await seedFailedForRetry({
			alivePid: 9992,
			aliveStart: "999",
		});
		const tree = createFakeTree({ identityOk: false });
		const registration = await createWorkerRegistration(sql, {
			workerId: `retry-worker-${crypto.randomUUID()}`,
			hostname: "retry-host",
			capacity: 1,
		});
		const worker = composeWorker({
			workerId: "retry-owner",
			workerRegistrationId: registration.id,
			tree,
		});
		const key = `retry:${seed.failedAttemptId}:ok`;
		const first = await worker.retry({
			featureId: seed.featureId,
			projectId: seed.projectId,
			taskApprovalId: seed.approvalId,
			branchName: seed.branchName,
			operationKey: key,
			reason: "safe retry",
			actorId: seed.adminId,
		});
		expect(first.kind).toBe("retried");
		if (first.kind !== "retried") throw new Error("expected retried");
		expect(first.attempt.predecessorAttemptId).toBe(seed.failedAttemptId);
		expect(first.attempt.status).toBe("QUEUED");
		expect(first.attempt.branchName).toBe(seed.branchName);

		const second = await worker.retry({
			featureId: seed.featureId,
			projectId: seed.projectId,
			taskApprovalId: seed.approvalId,
			branchName: seed.branchName,
			operationKey: key,
			reason: "safe retry",
			actorId: seed.adminId,
		});
		expect(second.kind).toBe("idempotent");

		const [counts] = await sql`
			SELECT
				(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${seed.featureId}) AS attempts,
				(SELECT count(*)::int FROM activity_events WHERE feature_id = ${seed.featureId} AND type = 'development.retried') AS activity,
				(SELECT count(*)::int FROM audit_events WHERE feature_id = ${seed.featureId} AND action = 'development.retry') AS audit
		`;
		expect(counts).toMatchObject({ attempts: 2, activity: 1, audit: 1 });
	});

	test("orphan startup reconciliation is idempotent and marks INTERRUPTED without auto-retry", async () => {
		const seed = await seedOwnedCancelRequested({
			status: "RUNNING",
			leaseExpired: true,
		});
		const tree = createFakeTree();
		const worker = composeWorker({
			workerId: seed.workerId,
			workerRegistrationId: seed.workerRegistrationId,
			tree,
		});
		const first = await worker.reconcileOrphans();
		const second = await worker.reconcileOrphans();
		expect(first).toBe(1);
		expect(second).toBe(0);

		const attempt = await getDevelopmentAttempt(sql, seed.attemptId);
		const feature = await getFeatureById(sql, seed.featureId);
		expect(attempt?.status).toBe("INTERRUPTED");
		expect(feature?.state).toBe("DEVELOPMENT_INTERRUPTED");

		const [evidence] = await sql`
			SELECT
				(SELECT count(*)::int FROM failure_records WHERE attempt_id = ${seed.attemptId}) AS failures,
				(SELECT count(*)::int FROM activity_events WHERE attempt_id = ${seed.attemptId} AND type = 'development.interrupted') AS activity,
				(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${seed.featureId} AND status = 'QUEUED') AS queued
		`;
		expect(evidence).toMatchObject({ failures: 1, activity: 1, queued: 0 });
	});

	test("cancels a real controllable process through worker-owned escalation", async () => {
		const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		const pid = child.pid;
		expect(pid).toBeGreaterThan(0);

		// Derive start identity the same way production verifyIdentity does.
		const realTree = createProcessTreeInspector();
		// Wait briefly so /proc is populated
		await Bun.sleep(50);
		const startIdentity = await readStartTimeMs(pid);

		const seed = await seedOwnedCancelRequested({
			processPid: pid,
			processStartIdentity: String(startIdentity),
		});
		const cancellation = createCancellationController({
			sql,
			tree: realTree,
			graceMs: 50,
			killGraceMs: 50,
			sleep: (ms) => Bun.sleep(ms),
		});
		const worker = createJobCommandWorker({
			sql,
			workerId: seed.workerId,
			workerRegistrationId: seed.workerRegistrationId,
			cancellation,
			retry: createRetryService({ sql }),
			tree: realTree,
			reconcileOrphans: () => reconcileOrphansAtWorkerStartup(sql),
			sleep: async () => {},
		});

		const result = await worker.processPendingCancels();
		expect(result.cancelsProcessed).toBe(1);
		expect(result.outcomes[0]?.outcome.kind).toBe("cancelled");

		const attempt = await getDevelopmentAttempt(sql, seed.attemptId);
		expect(attempt?.status).toBe("CANCELLED");

		// Process should no longer verify as the same identity (exited or replaced).
		const stillSame = await realTree.verifyIdentity(pid, startIdentity);
		expect(stillSame).toBe(false);
		try {
			child.kill(9);
		} catch {
			/* already gone */
		}
		await child.exited.catch(() => undefined);
	});
});

async function readStartTimeMs(pid: number): Promise<number> {
	const stat = await Bun.file(`/proc/${pid}/stat`).text();
	const close = stat.lastIndexOf(")");
	const rest = stat
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	const startTicks = Number(rest[19]);
	const procStat = await Bun.file("/proc/stat").text();
	const btimeLine = procStat.split("\n").find((line) => line.startsWith("btime "));
	const btime = Number((btimeLine ?? "btime 0").slice(6).trim()) * 1000;
	const clk = 100;
	return Math.floor(btime + (startTicks * 1000) / clk);
}
