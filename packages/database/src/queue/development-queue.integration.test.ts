import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { createDatabaseClient, type DatabaseClient, type Sql } from "../client";
import { createAdminAccount, createTaskApproval } from "../repositories/core-repositories";
import {
	createDevelopmentAttempt,
	createWorkerRegistration,
	getDevelopmentAttempt,
} from "../repositories/workflow-repositories";
import { createDatabaseFixture, type DatabaseFixture } from "../testing/database-fixture";
import { applyCoreMigration } from "../schema/core-migration";
import { applyWorkflowMigration } from "../schema/workflow-migration";
import { createDevelopmentQueue, type DevelopmentQueue } from "./development-queue";
import { createLeaseReconciler, type LeaseReconciler } from "./lease-reconciler";
import type { FeatureRow, ProjectRow } from "../repositories/core-repositories";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

let client: DatabaseClient;
let sql: Sql;
let fixture: DatabaseFixture;

/** Controllable fake clock starting at a fixed epoch. */
class FakeClock {
	private current: number;

	constructor(startIso: string) {
		this.current = new Date(startIso).getTime();
	}

	now(): Date {
		return new Date(this.current);
	}

	advance(ms: number): void {
		this.current += ms;
	}

	boundNow(): () => Date {
		return () => this.now();
	}
}

async function seedApprovedFeature(
	sql: Sql,
	project: ProjectRow,
	feature: FeatureRow,
): Promise<{ approvalId: string }> {
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$seed",
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/feature.json",
		checksum: `sha256:${crypto.randomUUID()}`,
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [{ id: "1", passes: false }] },
		approvedByAdminId: admin.id,
	});
	return { approvalId: approval.id };
}

async function seedQueuedAttempt(
	sql: Sql,
	projectId: string,
	featureId: string,
	taskApprovalId: string,
	branchName: string,
	opts?: { enqueueAt?: Date },
): Promise<string> {
	const attempt = await createDevelopmentAttempt(sql, {
		projectId,
		featureId,
		taskApprovalId,
		branchName,
		operationKey: `approve_and_queue:${crypto.randomUUID()}`,
		status: "QUEUED",
	});
	if (opts?.enqueueAt) {
		await sql`
			UPDATE development_job_attempts
			SET enqueued_at = ${opts.enqueueAt}
			WHERE id = ${attempt.id}
		`;
	}
	return attempt.id;
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

describe("development queue", () => {
	let clock: FakeClock;
	let queue: DevelopmentQueue;
	let workerId: string;

	beforeEach(() => {
		clock = new FakeClock("2026-07-18T00:00:00Z");
		workerId = `worker-${crypto.randomUUID()}`;
		queue = createDevelopmentQueue(sql, {
			maxConcurrent: 4,
			leaseDurationMs: 30_000,
			clock: clock.boundNow(),
		});
	});

	test("claims oldest QUEUED attempt first (FIFO) and marks it RUNNING with worker and lease", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);

		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName, {
			enqueueAt: new Date("2026-07-18T00:01:00Z"),
		});
		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName, {
			enqueueAt: new Date("2026-07-18T00:00:00Z"),
		});
		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName, {
			enqueueAt: new Date("2026-07-18T00:02:00Z"),
		});

		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });

		const claimed = await queue.claimNextAttempt(workerId);
		expect(claimed).not.toBeNull();
		expect(claimed!.attempt.status).toBe("RUNNING");
		expect(claimed!.attempt.workerRegistrationId).toBeTruthy();
		expect(claimed!.attempt.leaseExpiresAt).not.toBeNull();
		expect(claimed!.attempt.startedAt).not.toBeNull();
		expect(claimed!.attempt.heartbeatAt).not.toBeNull();

		const fetched = await getDevelopmentAttempt(sql, claimed!.attempt.id);
		expect(fetched!.enqueuedAt.getTime()).toBe(new Date("2026-07-18T00:00:00Z").getTime());
	});

	test("does not claim any attempt when none are QUEUED", async () => {
		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });
		const claimed = await queue.claimNextAttempt(workerId);
		expect(claimed).toBeNull();
	});

	test("does not claim when worker registration does not exist", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);
		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName);

		const claimed = await queue.claimNextAttempt("nonexistent-worker");
		expect(claimed).toBeNull();
	});

	test("at most one attempt claimed from the same project even when multiple are QUEUED", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);

		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName, {
			enqueueAt: new Date("2026-07-18T00:00:00Z"),
		});
		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName, {
			enqueueAt: new Date("2026-07-18T00:01:00Z"),
		});

		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });

		const first = await queue.claimNextAttempt(workerId);
		expect(first).not.toBeNull();

		const second = await queue.claimNextAttempt(workerId);
		expect(second).toBeNull();
	});

	test("does not claim a QUEUED attempt for a project that already has a RUNNING attempt", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);

		const existingWorker = await createWorkerRegistration(sql, {
			workerId: `wrk-existing-${crypto.randomUUID()}`,
			hostname: "existing-host",
		});

		await createDevelopmentAttempt(sql, {
			projectId: base.projectA.id,
			featureId: base.featureA.id,
			taskApprovalId: approvalId,
			branchName: base.featureA.branchName,
			operationKey: `running:${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: existingWorker.id,
			startedAt: new Date(),
		});

		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName);

		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });

		const claimed = await queue.claimNextAttempt(workerId);
		expect(claimed).toBeNull();
	});

	test("enforces global concurrent capacity (default 4)", async () => {
		const projects: ProjectRow[] = [];

		const ws = await fixture.twoProjects();
		projects.push(ws.projectA, ws.projectB);

		// Create 3 more projects with unique names using the fixture's projectA pattern
		const { createProject } = await import("../repositories/core-repositories");
		for (let i = 3; i <= 5; i++) {
			const extra = await createProject(sql, {
				workspaceId: ws.workspace.id,
				name: `Project ${i}`,
				slug: `project-${i}`,
				githubOwner: "acme",
				githubRepo: `project-${i}`,
				canonicalPath: `/workspaces/project-${i}`,
				developmentBranch: "main",
			});
			projects.push(extra);
		}

		for (const project of projects) {
			const feat = await fixture.featureInProject(project.id, `feat-${project.slug}`);
			const { approvalId } = await seedApprovedFeature(sql, project, feat);
			await seedQueuedAttempt(sql, project.id, feat.id, approvalId, feat.branchName);
		}

		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });

		const claims: Array<{ projectId: string }> = [];
		for (let i = 0; i < 4; i++) {
			const result = await queue.claimNextAttempt(workerId);
			expect(result).not.toBeNull();
			claims.push({ projectId: result!.attempt.projectId });
		}

		const claimedProjectIds = new Set(claims.map((c) => c.projectId));
		expect(claimedProjectIds.size).toBe(4);

		const fifth = await queue.claimNextAttempt(workerId);
		expect(fifth).toBeNull();
	});

	test("capacity is configurable", async () => {
		const smallQueue = createDevelopmentQueue(sql, {
			maxConcurrent: 2,
			leaseDurationMs: 30_000,
			clock: clock.boundNow(),
		});

		const projects: ProjectRow[] = [];
		const ws = await fixture.twoProjects();
		projects.push(ws.projectA, ws.projectB);

		const { createProject } = await import("../repositories/core-repositories");
		for (let i = 3; i <= 4; i++) {
			const extra = await createProject(sql, {
				workspaceId: ws.workspace.id,
				name: `Project ${i}`,
				slug: `project-${i}`,
				githubOwner: "acme",
				githubRepo: `project-${i}`,
				canonicalPath: `/workspaces/project-${i}`,
				developmentBranch: "main",
			});
			projects.push(extra);
		}

		for (const project of projects) {
			const feat = await fixture.featureInProject(project.id, `feat-${project.slug}`);
			const { approvalId } = await seedApprovedFeature(sql, project, feat);
			await seedQueuedAttempt(sql, project.id, feat.id, approvalId, feat.branchName);
		}

		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });

		expect(await smallQueue.claimNextAttempt(workerId)).not.toBeNull();
		expect(await smallQueue.claimNextAttempt(workerId)).not.toBeNull();
		expect(await smallQueue.claimNextAttempt(workerId)).toBeNull();
	});

	test("claim is transactional — on concurrent race only one worker obtains the attempt", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);
		await seedQueuedAttempt(sql, base.projectA.id, base.featureA.id, approvalId, base.featureA.branchName);

		await createWorkerRegistration(sql, { workerId, hostname: "test-host" });

		const client2 = createDatabaseClient(DATABASE_URL);
		try {
			const queue2 = createDevelopmentQueue(client2.sql, {
				maxConcurrent: 4,
				leaseDurationMs: 30_000,
				clock: clock.boundNow(),
			});

			const w2 = `worker-${crypto.randomUUID()}`;
			await createWorkerRegistration(client2.sql, { workerId: w2, hostname: "test-host-2" });

			const [r1, r2] = await Promise.all([
				queue.claimNextAttempt(workerId),
				queue2.claimNextAttempt(w2),
			]);

			const successes = [r1, r2].filter(Boolean);
			expect(successes.length).toBe(1);
		} finally {
			await client2.end();
		}
	});
});

describe("lease reconciler", () => {
	let clock: FakeClock;
	let reconciler: LeaseReconciler;

	beforeEach(() => {
		clock = new FakeClock("2026-07-18T00:00:00Z");
		reconciler = createLeaseReconciler(sql, { clock: clock.boundNow() });
	});

	async function seedRunningAttempt(s: Sql): Promise<{
		projectA: ProjectRow;
		projectB: ProjectRow;
		featureA: FeatureRow;
		attemptId: string;
		workerRegId: string;
	}> {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(s, base.projectA, base.featureA);
		const workerReg = await createWorkerRegistration(s, {
			workerId: `wrk-${crypto.randomUUID()}`,
			hostname: "test-host",
		});
		const attempt = await createDevelopmentAttempt(s, {
			projectId: base.projectA.id,
			featureId: base.featureA.id,
			taskApprovalId: approvalId,
			branchName: base.featureA.branchName,
			operationKey: `approve_and_queue:${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: workerReg.id,
			startedAt: clock.now(),
			leaseExpiresAt: new Date(clock.now().getTime() + 30_000),
			heartbeatAt: clock.now(),
		});
		return {
			projectA: base.projectA,
			projectB: base.projectB,
			featureA: base.featureA,
			attemptId: attempt.id,
			workerRegId: workerReg.id,
		};
	}

	test("marks expired lease as INTERRUPTED and does not requeue", async () => {
		const { attemptId } = await seedRunningAttempt(sql);
		clock.advance(60_000);

		const count = await reconciler.interruptExpiredLeases();
		expect(count).toBe(1);

		const attempt = await getDevelopmentAttempt(sql, attemptId);
		expect(attempt!.status).toBe("INTERRUPTED");
	});

	test("does not mark non-expired leases", async () => {
		const { attemptId } = await seedRunningAttempt(sql);
		clock.advance(15_000);

		const count = await reconciler.interruptExpiredLeases();
		expect(count).toBe(0);

		const attempt = await getDevelopmentAttempt(sql, attemptId);
		expect(attempt!.status).toBe("RUNNING");
	});

	test("marks multiple expired attempts across different projects", async () => {
		const a1 = await seedRunningAttempt(sql);

		const featB = await fixture.featureInProject(a1.projectB.id, "feat-b");
		const { approvalId: appB } = await seedApprovedFeature(sql, a1.projectB, featB);
		const wr2 = await createWorkerRegistration(sql, {
			workerId: `wrk-${crypto.randomUUID()}`,
			hostname: "test-host-2",
		});
		await createDevelopmentAttempt(sql, {
			projectId: a1.projectB.id,
			featureId: featB.id,
			taskApprovalId: appB,
			branchName: featB.branchName,
			operationKey: `approve_and_queue:${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: wr2.id,
			startedAt: clock.now(),
			leaseExpiresAt: new Date(clock.now().getTime() + 30_000),
			heartbeatAt: clock.now(),
		});

		clock.advance(60_000);

		const count = await reconciler.interruptExpiredLeases();
		expect(count).toBe(2);
	});

	test("no-op when no expired leases exist", async () => {
		await seedRunningAttempt(sql);
		const count = await reconciler.interruptExpiredLeases();
		expect(count).toBe(0);
	});

	test("does not interrupt SUCCEEDED, FAILED, or CANCELLED attempts", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);

		await createDevelopmentAttempt(sql, {
			projectId: base.projectA.id,
			featureId: base.featureA.id,
			taskApprovalId: approvalId,
			branchName: base.featureA.branchName,
			operationKey: `done:${crypto.randomUUID()}`,
			status: "SUCCEEDED",
			leaseExpiresAt: new Date(clock.now().getTime() - 60_000),
		});

		clock.advance(60_000);

		const count = await reconciler.interruptExpiredLeases();
		expect(count).toBe(0);
	});
});

describe("heartbeat (via renewLease)", () => {
	test("renews lease only for matching live ownership", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);
		const wr = await createWorkerRegistration(sql, {
			workerId: "owner-worker",
			hostname: "test-host",
		});
		const attempt = await createDevelopmentAttempt(sql, {
			projectId: base.projectA.id,
			featureId: base.featureA.id,
			taskApprovalId: approvalId,
			branchName: base.featureA.branchName,
			operationKey: `approve_and_queue:${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: wr.id,
			leaseExpiresAt: new Date(Date.now() + 30_000),
			heartbeatAt: new Date(),
		});

		const { renewLease } = await import("../repositories/workflow-repositories");
		const renewed = await renewLease(sql, {
			attemptId: attempt.id,
			workerRegistrationId: wr.id,
			leaseExpiresAt: new Date(Date.now() + 60_000),
		});
		expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

		const wrongId = "00000000-0000-0000-0000-000000000000";
		await expect(
			renewLease(sql, {
				attemptId: attempt.id,
				workerRegistrationId: wrongId,
				leaseExpiresAt: new Date(Date.now() + 90_000),
			}),
		).rejects.toThrow(/lease renew denied/);
	});

	test("stale workers cannot overwrite a newer owner", async () => {
		const base = await fixture.featureReady();
		const { approvalId } = await seedApprovedFeature(sql, base.projectA, base.featureA);
		const wr1 = await createWorkerRegistration(sql, {
			workerId: "worker-1",
			hostname: "host-1",
		});
		const wr2 = await createWorkerRegistration(sql, {
			workerId: "worker-2",
			hostname: "host-2",
		});

		const attempt = await createDevelopmentAttempt(sql, {
			projectId: base.projectA.id,
			featureId: base.featureA.id,
			taskApprovalId: approvalId,
			branchName: base.featureA.branchName,
			operationKey: `approve_and_queue:${crypto.randomUUID()}`,
			status: "RUNNING",
			workerRegistrationId: wr1.id,
			leaseExpiresAt: new Date(Date.now() + 30_000),
			heartbeatAt: new Date(),
		});

		const { updateAttemptStatus } = await import("../repositories/workflow-repositories");
		await updateAttemptStatus(sql, attempt.id, {
			status: "RUNNING",
			workerRegistrationId: wr2.id,
		});

		const { renewLease } = await import("../repositories/workflow-repositories");
		await expect(
			renewLease(sql, {
				attemptId: attempt.id,
				workerRegistrationId: wr1.id,
				leaseExpiresAt: new Date(Date.now() + 60_000),
			}),
		).rejects.toThrow(/lease renew denied/);
	});
});
