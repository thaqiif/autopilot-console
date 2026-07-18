import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, type DatabaseClient, type Sql } from "../client";
import {
	createAdminAccount,
	createFeature,
	createProject,
	createRelease,
	createTaskApproval,
	createWorkspace,
} from "../repositories/core-repositories";
import {
	appendActivityEvent,
	appendAuditEvent,
	appendDiagnosticLogChunk,
	appendFailureRecord,
	appendProgressSnapshot,
	claimOutboxIntent,
	claimScheduledReconciliation,
	createDevelopmentAttempt,
	createIdempotencyRecord,
	createOutboxIntent,
	createScheduledReconciliation,
	createWorkerRegistration,
	getDevelopmentAttempt,
	heartbeatWorker,
	renewLease,
	updateAttemptStatus,
} from "../repositories/workflow-repositories";
import { applyCoreMigration, rollbackCoreMigration } from "./core-migration";
import {
	applyWorkflowMigration,
	rollbackWorkflowMigration,
	WORKFLOW_VERSION,
} from "./workflow-migration";
import { createDatabaseFixture, type DatabaseFixture } from "../testing/database-fixture";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = join(packageRoot, "migrations");

let client: DatabaseClient;
let sql: Sql;
let fixture: DatabaseFixture;

async function mustReject(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected operation to reject");
}

async function seedApprovedFeature(sql: Sql) {
	const base = await fixture.featureReady();
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$seed",
	});
	const approval = await createTaskApproval(sql, {
		projectId: base.projectA.id,
		featureId: base.featureA.id,
		relativeTaskPath: "docs/tasks/feature.json",
		checksum: "sha256:abc123",
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [{ id: "1", passes: false }] },
		approvedByAdminId: admin.id,
	});
	return { ...base, admin, approval };
}

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
	await sql.unsafe("CREATE SCHEMA public");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO postgres");
	await sql.unsafe("GRANT ALL ON SCHEMA public TO public");
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

afterAll(async () => {
	await client.end();
});

async function ensureSchemas(): Promise<void> {
	const tables = await sql`
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'development_job_attempts'
	`;
	if (tables.length === 0) {
		await applyCoreMigration(sql);
		await applyWorkflowMigration(sql);
	}
}

beforeEach(async () => {
	await ensureSchemas();
	await sql.unsafe(`
		TRUNCATE TABLE
			outbox_intents,
			scheduled_reconciliation_jobs,
			idempotency_records,
			diagnostic_log_chunks,
			progress_snapshots,
			failure_records,
			activity_events,
			audit_events,
			development_job_attempts,
			worker_registrations,
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
	fixture = createDatabaseFixture(sql);
});

describe("workflow schema migration", () => {
	test("migration file 0002_workflow_records.sql exists and applies cleanly", async () => {
		const files = await readdir(migrationsDir);
		expect(files).toContain("0002_workflow_records.sql");
		const body = await readFile(join(migrationsDir, "0002_workflow_records.sql"), "utf8");
		expect(body.length).toBeGreaterThan(100);
		expect(WORKFLOW_VERSION).toBe("0002_workflow_records");
		await expect(applyWorkflowMigration(sql)).resolves.toBeUndefined();
	});

	test("rollback removes workflow tables then reapply restores them", async () => {
		await rollbackWorkflowMigration(sql);
		const afterRollback = await sql`
			SELECT tablename FROM pg_tables WHERE schemaname = 'public'
		`;
		const names = afterRollback.map((r) => r.tablename as string);
		expect(names).not.toContain("development_job_attempts");
		expect(names).not.toContain("activity_events");
		expect(names).not.toContain("audit_events");
		expect(names).not.toContain("outbox_intents");
		// core remains
		expect(names).toContain("features");

		await applyWorkflowMigration(sql);
		const afterApply = await sql`
			SELECT tablename FROM pg_tables WHERE schemaname = 'public'
		`;
		const restored = afterApply.map((r) => r.tablename as string);
		expect(restored).toContain("development_job_attempts");
		expect(restored).toContain("progress_snapshots");
		expect(restored).toContain("diagnostic_log_chunks");
		expect(restored).toContain("failure_records");
		expect(restored).toContain("activity_events");
		expect(restored).toContain("audit_events");
		expect(restored).toContain("worker_registrations");
		expect(restored).toContain("scheduled_reconciliation_jobs");
		expect(restored).toContain("outbox_intents");
		expect(restored).toContain("idempotency_records");
	});
});

describe("development job attempts", () => {
	test("persist immutable feature project approval branch enqueue predecessor process data and all statuses", async () => {
		const seed = await seedApprovedFeature(sql);
		const attempt = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: "approve_and_queue:project=a:feature=b:checksum=sha256:abc123",
			status: "QUEUED",
		});
		expect(attempt.id).toBeTruthy();
		expect(attempt.projectId).toBe(seed.projectA.id);
		expect(attempt.featureId).toBe(seed.featureA.id);
		expect(attempt.taskApprovalId).toBe(seed.approval.id);
		expect(attempt.branchName).toBe(seed.featureA.branchName);
		expect(attempt.status).toBe("QUEUED");
		expect(attempt.enqueuedAt).toBeInstanceOf(Date);
		expect(attempt.predecessorAttemptId).toBeNull();

		const statuses = [
			"QUEUED",
			"RUNNING",
			"CANCEL_REQUESTED",
			"SUCCEEDED",
			"FAILED",
			"INTERRUPTED",
			"CANCELLED",
		] as const;
		for (const status of statuses) {
			const a = await createDevelopmentAttempt(sql, {
				projectId: seed.projectA.id,
				featureId: seed.featureA.id,
				taskApprovalId: seed.approval.id,
				branchName: seed.featureA.branchName,
				operationKey: `op-${status}-${crypto.randomUUID()}`,
				status,
			});
			expect(a.status).toBe(status);
		}

		// process identity, heartbeat, exit, cancellation, structured result
		const worker = await createWorkerRegistration(sql, {
			workerId: "worker-1",
			hostname: "host-a",
		});
		const running = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `run-${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: worker.id,
			processPid: 4242,
			processStartIdentity: "start-token-1",
			leaseExpiresAt: new Date(Date.now() + 60_000),
			heartbeatAt: new Date(),
		});
		expect(running.processPid).toBe(4242);
		expect(running.processStartIdentity).toBe("start-token-1");
		expect(running.workerRegistrationId).toBe(worker.id);

		const finished = await updateAttemptStatus(sql, running.id, {
			status: "SUCCEEDED",
			endedAt: new Date(),
			exitCode: 0,
			structuredResult: { allPassed: true, stuck: false },
		});
		expect(finished.status).toBe("SUCCEEDED");
		expect(finished.exitCode).toBe(0);
		expect(finished.structuredResult).toEqual({ allPassed: true, stuck: false });

		const cancelled = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `cancel-${crypto.randomUUID()}`,
			status: "CANCELLED",
			cancellationRequestedAt: new Date(),
			cancellationReason: "owner requested",
		});
		expect(cancelled.cancellationReason).toBe("owner requested");

		// predecessor link for retry
		const retry = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `retry-${crypto.randomUUID()}`,
			status: "QUEUED",
			predecessorAttemptId: finished.id,
		});
		expect(retry.predecessorAttemptId).toBe(finished.id);

		// timestamps are timezone-aware UTC
		const raw = await sql`
			SELECT enqueued_at, pg_typeof(enqueued_at)::text AS t
			FROM development_job_attempts WHERE id = ${attempt.id}
		`;
		expect(String(raw[0]?.t)).toContain("timestamp");
	});

	test("prevents more than one claimed or running attempt per project", async () => {
		const seed = await seedApprovedFeature(sql);
		const worker = await createWorkerRegistration(sql, {
			workerId: "w-active",
			hostname: "h1",
		});
		await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `active-1-${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: worker.id,
			processPid: 1,
			processStartIdentity: "a",
			leaseExpiresAt: new Date(Date.now() + 60_000),
		});

		const feature2 = await fixture.featureInProject(seed.projectA.id, "second-feature");
		const approval2 = await createTaskApproval(sql, {
			projectId: seed.projectA.id,
			featureId: feature2.id,
			relativeTaskPath: "docs/tasks/other.json",
			checksum: "sha256:other",
			schemaCompatibilityVersion: "1",
			requirementsSnapshot: { requirements: [] },
			approvedByAdminId: seed.admin.id,
		});

		const err = await mustReject(() =>
			createDevelopmentAttempt(sql, {
				projectId: seed.projectA.id,
				featureId: feature2.id,
				taskApprovalId: approval2.id,
				branchName: feature2.branchName,
				operationKey: `active-2-${crypto.randomUUID()}`,
				status: "RUNNING",
				workerRegistrationId: worker.id,
				processPid: 2,
				processStartIdentity: "b",
				leaseExpiresAt: new Date(Date.now() + 60_000),
			}),
		);
		expect(String(err.message).toLowerCase()).toMatch(/unique|duplicate|active|one/);

		// CANCEL_REQUESTED also counts as active
		const err2 = await mustReject(() =>
			createDevelopmentAttempt(sql, {
				projectId: seed.projectA.id,
				featureId: feature2.id,
				taskApprovalId: approval2.id,
				branchName: feature2.branchName,
				operationKey: `active-3-${crypto.randomUUID()}`,
				status: "CANCEL_REQUESTED",
			}),
		);
		expect(String(err2.message).toLowerCase()).toMatch(/unique|duplicate|active|one/);

		// Different project can run concurrently
		const featureB = await fixture.featureInProject(seed.projectB.id, "b-feature");
		const approvalB = await createTaskApproval(sql, {
			projectId: seed.projectB.id,
			featureId: featureB.id,
			relativeTaskPath: "docs/tasks/b.json",
			checksum: "sha256:b",
			schemaCompatibilityVersion: "1",
			requirementsSnapshot: { requirements: [] },
			approvedByAdminId: seed.admin.id,
		});
		const other = await createDevelopmentAttempt(sql, {
			projectId: seed.projectB.id,
			featureId: featureB.id,
			taskApprovalId: approvalB.id,
			branchName: featureB.branchName,
			operationKey: `other-project-${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: worker.id,
			processPid: 9,
			processStartIdentity: "c",
			leaseExpiresAt: new Date(Date.now() + 60_000),
		});
		expect(other.projectId).toBe(seed.projectB.id);
	});

	test("prevents duplicate active attempts for the same operation key", async () => {
		const seed = await seedApprovedFeature(sql);
		const opKey = "approve_and_queue:project=x:feature=y:checksum=sha256:abc123";
		await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: opKey,
			status: "QUEUED",
		});
		const err = await mustReject(() =>
			createDevelopmentAttempt(sql, {
				projectId: seed.projectA.id,
				featureId: seed.featureA.id,
				taskApprovalId: seed.approval.id,
				branchName: seed.featureA.branchName,
				operationKey: opKey,
				status: "QUEUED",
			}),
		);
		expect(String(err.message).toLowerCase()).toMatch(/unique|duplicate|operation/);
	});

	test("cross-project foreign keys reject mismatched feature or approval", async () => {
		const seed = await seedApprovedFeature(sql);
		const featureB = await fixture.featureInProject(seed.projectB.id, "cross");
		const err = await mustReject(() =>
			createDevelopmentAttempt(sql, {
				projectId: seed.projectA.id,
				featureId: featureB.id,
				taskApprovalId: seed.approval.id,
				branchName: featureB.branchName,
				operationKey: `cross-${crypto.randomUUID()}`,
				status: "QUEUED",
			}),
		);
		expect(String(err.message).toLowerCase()).toMatch(/project|match|hierarchy|does not/);
	});
});

describe("progress snapshots logs failures activity and audit", () => {
	test("retain attempt and project ownership with append-only semantics", async () => {
		const seed = await seedApprovedFeature(sql);
		const attempt = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `snap-${crypto.randomUUID()}`,
			status: "RUNNING",
		});

		const snap1 = await appendProgressSnapshot(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			attemptId: attempt.id,
			sourceVersion: 1,
			summary: { total: 3, passed: 0, remaining: 3 },
			requirements: [{ id: "1", passes: false }],
		});
		const snap2 = await appendProgressSnapshot(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			attemptId: attempt.id,
			sourceVersion: 2,
			summary: { total: 3, passed: 1, remaining: 2 },
			requirements: [{ id: "1", passes: true }],
		});
		expect(snap2.sourceVersion).toBe(2);
		expect(snap1.id).not.toBe(snap2.id);

		// progress snapshots are append-only (no update of content)
		const snapErr = await mustReject(() =>
			sql`UPDATE progress_snapshots SET source_version = 99 WHERE id = ${snap1.id}`,
		);
		expect(String(snapErr.message).toLowerCase()).toMatch(/immutable|append|cannot|trigger/);

		const log = await appendDiagnosticLogChunk(sql, {
			projectId: seed.projectA.id,
			attemptId: attempt.id,
			sequence: 1,
			stream: "stdout",
			body: "hello",
			truncated: false,
		});
		expect(log.sequence).toBe(1);
		const logErr = await mustReject(() =>
			sql`UPDATE diagnostic_log_chunks SET body = 'x' WHERE id = ${log.id}`,
		);
		expect(String(logErr.message).toLowerCase()).toMatch(/immutable|append|cannot|trigger/);

		const failure = await appendFailureRecord(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			attemptId: attempt.id,
			category: "process",
			summary: "nonzero exit",
			recommendedAction: "retry_development",
			details: { exitCode: 1 },
		});
		expect(failure.category).toBe("process");
		const failErr = await mustReject(() =>
			sql`UPDATE failure_records SET summary = 'changed' WHERE id = ${failure.id}`,
		);
		expect(String(failErr.message).toLowerCase()).toMatch(/immutable|append|cannot|trigger/);

		const activity = await appendActivityEvent(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			attemptId: attempt.id,
			type: "job.started",
			summary: "Job started",
			source: "worker",
			metadata: { workerId: "w1" },
		});
		expect(activity.type).toBe("job.started");
		const actErr = await mustReject(() =>
			sql`UPDATE activity_events SET summary = 'nope' WHERE id = ${activity.id}`,
		);
		expect(String(actErr.message).toLowerCase()).toMatch(/immutable|append|cannot|trigger/);

		const audit = await appendAuditEvent(sql, {
			actorType: "worker",
			actorId: "worker-1",
			action: "job.claim",
			targetType: "development_job_attempt",
			targetId: attempt.id,
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			attemptId: attempt.id,
			correlationId: "corr-1",
			result: "success",
			priorValues: { status: "QUEUED" },
			nextValues: { status: "RUNNING" },
		});
		expect(audit.actorType).toBe("worker");
		expect(audit.action).toBe("job.claim");
		expect(audit.priorValues).toEqual({ status: "QUEUED" });
		expect(audit.nextValues).toEqual({ status: "RUNNING" });
		expect(audit.correlationId).toBe("corr-1");
		const auditErr = await mustReject(() =>
			sql`UPDATE audit_events SET action = 'tamper' WHERE id = ${audit.id}`,
		);
		expect(String(auditErr.message).toLowerCase()).toMatch(/immutable|append|cannot|trigger/);

		// cross-project ownership rejected
		const cross = await mustReject(() =>
			appendProgressSnapshot(sql, {
				projectId: seed.projectB.id,
				featureId: seed.featureA.id,
				attemptId: attempt.id,
				sourceVersion: 3,
				summary: {},
				requirements: [],
			}),
		);
		expect(String(cross.message).toLowerCase()).toMatch(/project|match|hierarchy|does not/);
	});
});

describe("workers leases schedules outbox and idempotency", () => {
	test("worker registrations and heartbeats survive and renew ownership only for matching owner", async () => {
		const worker = await createWorkerRegistration(sql, {
			workerId: "worker-alpha",
			hostname: "box-1",
			capacity: 4,
		});
		expect(worker.workerId).toBe("worker-alpha");
		expect(worker.capacity).toBe(4);

		const hb = await heartbeatWorker(sql, worker.id, { activeJobs: 1 });
		expect(hb.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(worker.registeredAt.getTime());

		const seed = await seedApprovedFeature(sql);
		const attempt = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `lease-${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: worker.id,
			processPid: 100,
			processStartIdentity: "id-1",
			leaseExpiresAt: new Date(Date.now() + 30_000),
			heartbeatAt: new Date(),
		});

		const renewed = await renewLease(sql, {
			attemptId: attempt.id,
			workerRegistrationId: worker.id,
			leaseExpiresAt: new Date(Date.now() + 60_000),
		});
		expect(renewed.workerRegistrationId).toBe(worker.id);

		const other = await createWorkerRegistration(sql, {
			workerId: "worker-beta",
			hostname: "box-2",
		});
		const steal = await mustReject(() =>
			renewLease(sql, {
				attemptId: attempt.id,
				workerRegistrationId: other.id,
				leaseExpiresAt: new Date(Date.now() + 90_000),
			}),
		);
		expect(String(steal.message).toLowerCase()).toMatch(/owner|lease|mismatch|not found|denied/);
	});

	test("scheduled reconciliation and outbox intents claim transactionally", async () => {
		const seed = await seedApprovedFeature(sql);
		const schedule = await createScheduledReconciliation(sql, {
			kind: "github_pr_poll",
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			notBefore: new Date(Date.now() - 1000),
			payload: { pullRequestNumber: 12 },
		});
		expect(schedule.kind).toBe("github_pr_poll");
		expect(schedule.status).toBe("pending");

		const claimed = await claimScheduledReconciliation(sql, {
			scheduleId: schedule.id,
			workerId: "worker-1",
		});
		expect(claimed?.status).toBe("claimed");
		expect(claimed?.claimedBy).toBe("worker-1");

		// second claim of same pending fails / returns null
		const again = await claimScheduledReconciliation(sql, {
			scheduleId: schedule.id,
			workerId: "worker-2",
		});
		expect(again).toBeNull();

		const outbox = await createOutboxIntent(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			kind: "create_pr",
			dedupeKey: `create_pr:${seed.featureA.id}`,
			payload: { branch: seed.featureA.branchName },
		});
		expect(outbox.status).toBe("pending");

		const outClaimed = await claimOutboxIntent(sql, {
			intentId: outbox.id,
			workerId: "worker-1",
		});
		expect(outClaimed?.status).toBe("claimed");

		const outAgain = await claimOutboxIntent(sql, {
			intentId: outbox.id,
			workerId: "worker-2",
		});
		expect(outAgain).toBeNull();

		// duplicate dedupe key rejected while active
		const dup = await mustReject(() =>
			createOutboxIntent(sql, {
				projectId: seed.projectA.id,
				featureId: seed.featureA.id,
				kind: "create_pr",
				dedupeKey: `create_pr:${seed.featureA.id}`,
				payload: { branch: seed.featureA.branchName },
			}),
		);
		expect(String(dup.message).toLowerCase()).toMatch(/unique|duplicate|dedupe/);
	});

	test("idempotency records store stable operation keys and reject duplicates", async () => {
		const seed = await seedApprovedFeature(sql);
		const attempt = await createDevelopmentAttempt(sql, {
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.featureA.branchName,
			operationKey: `idemp-attempt-${crypto.randomUUID()}`,
			status: "QUEUED",
		});
		const key = "approve_and_queue:project=p:feature=f:checksum=c";
		const rec = await createIdempotencyRecord(sql, {
			operationKey: key,
			projectId: seed.projectA.id,
			featureId: seed.featureA.id,
			attemptId: attempt.id,
			result: { attemptId: attempt.id },
		});
		expect(rec.operationKey).toBe(key);
		const err = await mustReject(() =>
			createIdempotencyRecord(sql, {
				operationKey: key,
				projectId: seed.projectA.id,
				featureId: seed.featureA.id,
				attemptId: attempt.id,
				result: { attemptId: attempt.id },
			}),
		);
		expect(String(err.message).toLowerCase()).toMatch(/unique|duplicate/);
	});
});

describe("transactional integrity", () => {
	test("transaction rollback leaves no partial domain mutation job activity audit idempotency or outbox", async () => {
		const seed = await seedApprovedFeature(sql);

		const err = await mustReject(async () => {
			await sql.begin(async (tx) => {
				const attempt = await createDevelopmentAttempt(tx, {
					projectId: seed.projectA.id,
					featureId: seed.featureA.id,
					taskApprovalId: seed.approval.id,
					branchName: seed.featureA.branchName,
					operationKey: `tx-${crypto.randomUUID()}`,
					status: "QUEUED",
				});
				await appendActivityEvent(tx, {
					projectId: seed.projectA.id,
					featureId: seed.featureA.id,
					attemptId: attempt.id,
					type: "job.queued",
					summary: "queued",
					source: "api",
					metadata: {},
				});
				await appendAuditEvent(tx, {
					actorType: "administrator",
					actorId: seed.admin.id,
					action: "job.enqueue",
					targetType: "development_job_attempt",
					targetId: attempt.id,
					projectId: seed.projectA.id,
					featureId: seed.featureA.id,
					attemptId: attempt.id,
					correlationId: "tx-corr",
					result: "success",
					priorValues: null,
					nextValues: { status: "QUEUED" },
				});
				await createIdempotencyRecord(tx, {
					operationKey: `tx-op-${attempt.id}`,
					projectId: seed.projectA.id,
					featureId: seed.featureA.id,
					attemptId: attempt.id,
					result: { attemptId: attempt.id },
				});
				await createOutboxIntent(tx, {
					projectId: seed.projectA.id,
					featureId: seed.featureA.id,
					kind: "push_branch",
					dedupeKey: `push:${attempt.id}`,
					payload: { attemptId: attempt.id },
				});
				throw new Error("force rollback");
			});
		});
		expect(String(err.message)).toContain("force rollback");

		const attempts = await sql`SELECT count(*)::int AS n FROM development_job_attempts`;
		const activities = await sql`SELECT count(*)::int AS n FROM activity_events`;
		const audits = await sql`SELECT count(*)::int AS n FROM audit_events`;
		const idemp = await sql`SELECT count(*)::int AS n FROM idempotency_records`;
		const outbox = await sql`SELECT count(*)::int AS n FROM outbox_intents`;
		expect(attempts[0]?.n).toBe(0);
		expect(activities[0]?.n).toBe(0);
		expect(audits[0]?.n).toBe(0);
		expect(idemp[0]?.n).toBe(0);
		expect(outbox[0]?.n).toBe(0);
	});
});
