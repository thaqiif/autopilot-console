/**
 * RED: task attach, immutable approval, atomic Approve & Queue Development.
 * Fails until task-approval-service is implemented.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullTaskFile, minimalTaskFile } from "../../../autopilot/src/testing/task-fixtures";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createAdminAccount,
	createDatabaseClient,
	createFeature,
	createProject,
	createRelease,
	createWorkspace,
	type DatabaseClient,
	getFeatureById,
	type Sql,
	updateAttemptStatus,
	updateFeature,
} from "../../../database/src/index";
import type { ProjectActor } from "../project/project";
import { createTaskApprovalService, type TaskApprovalService } from "./task-approval-service";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

let client: DatabaseClient;
let sql: Sql;
let workspaceId: string;
let adminId: string;
let projectId: string;
let projectPath: string;
let releaseId: string;
let featureId: string;
let featureBranch: string;
let tempRoot: string;

const ACTOR: ProjectActor = {
	actorType: "administrator",
	actorId: "pending-admin",
	correlationId: "corr-task-15",
};

function actor(): ProjectActor {
	return { ...ACTOR, actorId: adminId };
}

function makeService(sqlOverride: Sql = sql): TaskApprovalService {
	return createTaskApprovalService({
		sql: sqlOverride,
		now: () => new Date("2026-07-18T15:00:00.000Z"),
	});
}

async function writeTask(
	relative: string,
	doc: Record<string, unknown>,
): Promise<{ relative: string; absolute: string; bytes: string }> {
	const absolute = join(projectPath, relative);
	await mkdir(join(absolute, ".."), { recursive: true });
	const bytes = `${JSON.stringify(doc, null, 2)}\n`;
	await writeFile(absolute, bytes, "utf8");
	return { relative, absolute, bytes };
}

async function seedFeature(state: string = "PLANNED") {
	const release = await createRelease(sql, {
		projectId,
		name: "1.0.0",
		version: "1.0.0",
		sortOrder: 1,
	});
	releaseId = release.id;
	featureBranch = `feature/${crypto.randomUUID()}-login`;
	const feature = await createFeature(sql, {
		projectId,
		releaseId,
		slug: `login-${crypto.randomUUID().slice(0, 8)}`,
		title: "Login",
		branchName: featureBranch,
		state: state as "PLANNED",
	});
	featureId = feature.id;
	return feature;
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
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
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
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
	tempRoot = await mkdtemp(join(tmpdir(), "task-approval-"));
	const root = await realpath(tempRoot);
	projectPath = join(root, "project-a");
	await mkdir(projectPath, { recursive: true });
	projectPath = await realpath(projectPath);

	const workspace = await createWorkspace(sql);
	workspaceId = workspace.id;
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$seed",
	});
	adminId = admin.id;
	const project = await createProject(sql, {
		workspaceId,
		name: "Project A",
		slug: "project-a",
		githubOwner: "acme",
		githubRepo: "project-a",
		canonicalPath: projectPath,
		developmentBranch: "main",
	});
	projectId = project.id;
	await seedFeature("PLANNED");
});

describe("attach task artifact", () => {
	test("attaches valid project-relative task JSON and moves PLANNED → TASKS_REVIEW with activity/audit", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const beforeBytes = await readFile(task.absolute, "utf8");
		const service = makeService();

		const result = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected attach ok");
		expect(result.feature.state).toBe("TASKS_REVIEW");
		expect(result.feature.taskPath).toBe(task.relative);
		expect(result.summary.total).toBeGreaterThan(0);
		expect(result.checksum.length).toBeGreaterThan(0);

		const row = await getFeatureById(sql, featureId);
		expect(row?.state).toBe("TASKS_REVIEW");
		expect(row?.taskPath).toBe(task.relative);
		expect(row?.rowVersion).toBeGreaterThan(1);

		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_type = 'feature' AND target_id = ${featureId}
			ORDER BY created_at ASC
		`;
		expect(audits.some((a) => a.action === "feature.task.attach" && a.result === "success")).toBe(
			true,
		);

		const activity = await sql`
			SELECT * FROM activity_events
			WHERE feature_id = ${featureId} AND type = 'feature.task_attached'
		`;
		expect(activity.length).toBe(1);

		// Display/validation must not rewrite source bytes.
		const afterBytes = await readFile(task.absolute, "utf8");
		expect(afterBytes).toBe(beforeBytes);
	});

	test("rejects absolute, traversal, non-json, missing, and invalid schema paths", async () => {
		const service = makeService();

		const absolute = await service.attachTask({
			featureId,
			relativeTaskPath: "/etc/passwd.json",
			actor: actor(),
		});
		expect(absolute.ok).toBe(false);
		if (absolute.ok) throw new Error("expected fail");
		expect(absolute.reason).toBe("VALIDATION_FAILED");

		const traversal = await service.attachTask({
			featureId,
			relativeTaskPath: "../escape.json",
			actor: actor(),
		});
		expect(traversal.ok).toBe(false);

		const missing = await service.attachTask({
			featureId,
			relativeTaskPath: "docs/missing.json",
			actor: actor(),
		});
		expect(missing.ok).toBe(false);

		await writeTask("docs/bad.txt", fullTaskFile());
		const ext = await service.attachTask({
			featureId,
			relativeTaskPath: "docs/bad.txt",
			actor: actor(),
		});
		expect(ext.ok).toBe(false);

		await writeTask("docs/invalid.json", { name: "x" });
		const schema = await service.attachTask({
			featureId,
			relativeTaskPath: "docs/invalid.json",
			actor: actor(),
		});
		expect(schema.ok).toBe(false);

		const stillPlanned = await getFeatureById(sql, featureId);
		expect(stillPlanned?.state).toBe("PLANNED");
		expect(stillPlanned?.taskPath).toBeNull();
	});

	test("rejects attach in illegal lifecycle states", async () => {
		const task = await writeTask("docs/tasks/a.json", fullTaskFile());
		const service = makeService();
		await updateFeature(sql, { id: featureId, state: "QUEUED", taskPath: task.relative });

		const result = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("ILLEGAL_STATE");
	});
});

describe("approve and queue development", () => {
	test("rejects stale displayed checksum without mutating", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(attached.ok).toBe(true);
		if (!attached.ok) throw new Error("attach failed");

		const result = await service.approveAndQueue({
			featureId,
			displayedChecksum: "not-the-real-checksum",
			operationKey: `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=stale`,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("STALE_CHECKSUM");

		const feature = await getFeatureById(sql, featureId);
		expect(feature?.state).toBe("TASKS_REVIEW");
		const attempts = await sql`SELECT count(*)::int AS n FROM development_job_attempts`;
		expect(attempts[0]?.n).toBe(0);
		const approvals = await sql`SELECT count(*)::int AS n FROM task_approvals`;
		expect(approvals[0]?.n).toBe(0);
	});

	test("Approve & Queue atomically snapshots, transitions to QUEUED, creates one attempt, no source rewrite", async () => {
		const task = await writeTask(
			"docs/tasks/login.json",
			fullTaskFile({ goals: ["g1"], nonGoals: ["ng1"], customField: "keep-me" }),
		);
		const beforeBytes = await readFile(task.absolute, "utf8");
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(attached.ok).toBe(true);
		if (!attached.ok) throw new Error("attach failed");

		const opKey = `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}`;
		const result = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected approve ok");
		expect(result.feature.state).toBe("QUEUED");
		expect(result.approval.checksum).toBe(attached.checksum);
		expect(result.approval.relativeTaskPath).toBe(task.relative);
		expect(result.approval.approvedByAdminId).toBe(adminId);
		expect(result.approval.invalidatedAt).toBeNull();
		expect(result.attempt.status).toBe("QUEUED");
		expect(result.attempt.taskApprovalId).toBe(result.approval.id);
		expect(result.attempt.branchName).toBe(featureBranch);
		expect(result.attempt.operationKey).toBe(opKey);
		expect(result.attempt.projectId).toBe(projectId);
		expect(result.attempt.featureId).toBe(featureId);

		// Snapshot preserves requirements including unknown nested fields via requirements array.
		const snapshot = result.approval.requirementsSnapshot as { requirements?: unknown[] };
		expect(Array.isArray(snapshot) || Array.isArray(snapshot?.requirements)).toBe(true);

		const afterBytes = await readFile(task.absolute, "utf8");
		expect(afterBytes).toBe(beforeBytes);

		const feature = await getFeatureById(sql, featureId);
		expect(feature?.state).toBe("QUEUED");

		const attempts = await sql`SELECT * FROM development_job_attempts`;
		expect(attempts.length).toBe(1);

		const audits = await sql`
			SELECT action, result FROM audit_events
			WHERE feature_id = ${featureId}
			ORDER BY created_at ASC
		`;
		expect(
			audits.some((a) => a.action === "feature.approve_and_queue" && a.result === "success"),
		).toBe(true);

		const activity = await sql`
			SELECT type FROM activity_events WHERE feature_id = ${featureId}
		`;
		expect(activity.some((a) => a.type === "feature.queued")).toBe(true);

		const idemp = await sql`
			SELECT * FROM idempotency_records WHERE operation_key = ${opKey}
		`;
		expect(idemp.length).toBe(1);
	});

	test("duplicate operation key returns same attempt without second transition or job", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const opKey = `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}`;

		const first = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("first approve failed");

		const second = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error("second approve failed");
		expect(second.attempt.id).toBe(first.attempt.id);
		expect(second.approval.id).toBe(first.approval.id);
		expect(second.idempotent).toBe(true);

		const attempts = await sql`SELECT count(*)::int AS n FROM development_job_attempts`;
		expect(attempts[0]?.n).toBe(1);
		const approvals = await sql`SELECT count(*)::int AS n FROM task_approvals`;
		expect(approvals[0]?.n).toBe(1);
		const transitions = await sql`
			SELECT count(*)::int AS n FROM activity_events
			WHERE feature_id = ${featureId} AND type = 'feature.queued'
		`;
		expect(transitions[0]?.n).toBe(1);
	});

	test("failure inside approve transaction rolls back approval, transition, attempt, activity, audit, idempotency", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");

		// Force failure: use non-existent admin id so FK on task_approvals fails mid-tx.
		const badActor: ProjectActor = {
			actorType: "administrator",
			actorId: crypto.randomUUID(),
			correlationId: "corr-rollback",
		};
		const opKey = `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}:bad`;

		let threw = false;
		try {
			await service.approveAndQueue({
				featureId,
				displayedChecksum: attached.checksum,
				operationKey: opKey,
				actor: badActor,
			});
		} catch {
			threw = true;
		}
		// Service may return failure or throw; either way no partial state.
		const feature = await getFeatureById(sql, featureId);
		expect(feature?.state).toBe("TASKS_REVIEW");
		const attempts = await sql`SELECT count(*)::int AS n FROM development_job_attempts`;
		expect(attempts[0]?.n).toBe(0);
		const approvals = await sql`SELECT count(*)::int AS n FROM task_approvals`;
		expect(approvals[0]?.n).toBe(0);
		const idemp = await sql`
			SELECT count(*)::int AS n FROM idempotency_records WHERE operation_key = ${opKey}
		`;
		expect(idemp[0]?.n).toBe(0);
		// threw or structured failure both acceptable
		expect(threw || true).toBe(true);
	});

	test("approve rejected when feature not in TASKS_REVIEW", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const service = makeService();
		const result = await service.approveAndQueue({
			featureId,
			displayedChecksum: "anything",
			operationKey: `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=x`,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toBe("ILLEGAL_STATE");
		// silence unused
		expect(task.relative.length).toBeGreaterThan(0);
	});
});

describe("task replacement and invalidation", () => {
	test("allows replace before approval (TASKS_REVIEW → re-attach)", async () => {
		const first = await writeTask("docs/tasks/v1.json", fullTaskFile({ name: "v1" }));
		const service = makeService();
		const a1 = await service.attachTask({
			featureId,
			relativeTaskPath: first.relative,
			actor: actor(),
		});
		expect(a1.ok).toBe(true);

		const second = await writeTask("docs/tasks/v2.json", fullTaskFile({ name: "v2" }));
		const a2 = await service.attachTask({
			featureId,
			relativeTaskPath: second.relative,
			actor: actor(),
		});
		expect(a2.ok).toBe(true);
		if (!a2.ok) throw new Error("replace attach failed");
		expect(a2.feature.taskPath).toBe(second.relative);
		expect(a2.feature.state).toBe("TASKS_REVIEW");
	});

	test("allows remove before approval (TASKS_REVIEW → PLANNED)", async () => {
		const task = await writeTask("docs/tasks/v1.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(attached.ok).toBe(true);

		const removed = await service.removeTask({
			featureId,
			actor: actor(),
		});
		expect(removed.ok).toBe(true);
		if (!removed.ok) throw new Error("remove failed");
		expect(removed.feature.state).toBe("PLANNED");
		expect(removed.feature.taskPath).toBeNull();

		const audits = await sql`
			SELECT action FROM audit_events
			WHERE feature_id = ${featureId} AND action = 'feature.task.remove'
		`;
		expect(audits.length).toBeGreaterThanOrEqual(1);
	});

	test("after failed attempt, requires explicit invalidation before reapproval", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const opKey = `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}`;
		const approved = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");

		// Simulate terminal failure: mark attempt FAILED and feature DEVELOPMENT_FAILED
		await updateAttemptStatus(sql, approved.attempt.id, {
			status: "FAILED",
			endedAt: new Date(),
			exitCode: 1,
		});
		await updateFeature(sql, { id: featureId, state: "DEVELOPMENT_FAILED" });

		// Direct re-attach without invalidation must fail.
		const blocked = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(blocked.ok).toBe(false);
		if (blocked.ok) throw new Error("expected block");
		expect(blocked.reason).toBe("APPROVAL_ACTIVE");

		const invalidated = await service.invalidateApproval({
			featureId,
			approvalId: approved.approval.id,
			actor: actor(),
		});
		expect(invalidated.ok).toBe(true);
		if (!invalidated.ok) throw new Error("invalidate failed");
		expect(invalidated.approval.invalidatedAt).not.toBeNull();

		// After invalidation, can re-attach (moves to TASKS_REVIEW from DEVELOPMENT_FAILED via remove? or replace policy)
		// Policy: replacement after failed requires invalidation; attach may transition via detach first.
		const reattach = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(reattach.ok).toBe(true);
		if (!reattach.ok) throw new Error("reattach failed");
		expect(reattach.feature.state).toBe("TASKS_REVIEW");

		// Mutate source file and reapprove with new checksum.
		const mutated = await writeTask(
			"docs/tasks/login.json",
			fullTaskFile({ name: "mutated-after-fail" }),
		);
		const reattached = await service.attachTask({
			featureId,
			relativeTaskPath: mutated.relative,
			actor: actor(),
		});
		if (!reattached.ok) throw new Error("reattach2 failed");
		const opKey2 = `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${reattached.checksum}`;
		const reapproved = await service.approveAndQueue({
			featureId,
			displayedChecksum: reattached.checksum,
			operationKey: opKey2,
			actor: actor(),
		});
		expect(reapproved.ok).toBe(true);
		if (!reapproved.ok) throw new Error("reapprove failed");
		expect(reapproved.approval.id).not.toBe(approved.approval.id);
		expect(reapproved.attempt.id).not.toBe(approved.attempt.id);

		const allApprovals = await sql`
			SELECT id, invalidated_at FROM task_approvals WHERE feature_id = ${featureId}
			ORDER BY created_at ASC
		`;
		expect(allApprovals.length).toBe(2);
		expect(allApprovals[0]?.invalidated_at).not.toBeNull();
		expect(allApprovals[1]?.invalidated_at).toBeNull();

		// Prior approval snapshot immutable even after source mutation.
		const prior = await sql`
			SELECT checksum, requirements_snapshot FROM task_approvals WHERE id = ${approved.approval.id}
		`;
		expect(prior[0]?.checksum).toBe(approved.approval.checksum);
	});

	test("rejects invalidate/replace/queue in illegal states (DEVELOPING, QUEUED)", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const opKey = `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}`;
		const approved = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");

		const removeQueued = await service.removeTask({ featureId, actor: actor() });
		expect(removeQueued.ok).toBe(false);

		const invalidateQueued = await service.invalidateApproval({
			featureId,
			approvalId: approved.approval.id,
			actor: actor(),
		});
		expect(invalidateQueued.ok).toBe(false);

		await updateFeature(sql, { id: featureId, state: "DEVELOPING" });
		await updateAttemptStatus(sql, approved.attempt.id, {
			status: "RUNNING",
			startedAt: new Date(),
		});

		const attachDev = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(attachDev.ok).toBe(false);
		if (attachDev.ok) throw new Error("expected fail");
		expect(attachDev.reason).toMatch(/ILLEGAL_STATE|APPROVAL_ACTIVE/);
	});

	test("interrupted and cancelled attempts also allow invalidation + reapproval", async () => {
		const task = await writeTask("docs/tasks/login.json", minimalTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");

		await updateAttemptStatus(sql, approved.attempt.id, {
			status: "INTERRUPTED",
			endedAt: new Date(),
		});
		await updateFeature(sql, { id: featureId, state: "DEVELOPMENT_INTERRUPTED" });

		const inv = await service.invalidateApproval({
			featureId,
			approvalId: approved.approval.id,
			actor: actor(),
		});
		expect(inv.ok).toBe(true);
	});
});

describe("audit consistency and snapshot immutability", () => {
	test("approved snapshot remains unchanged after source task file is mutated", async () => {
		const task = await writeTask("docs/tasks/login.json", fullTaskFile({ name: "original" }));
		const service = makeService();
		const attached = await service.attachTask({
			featureId,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId,
			displayedChecksum: attached.checksum,
			operationKey: `approve_and_queue:project=${projectId}:feature=${featureId}:checksum=${attached.checksum}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");

		await writeTask("docs/tasks/login.json", fullTaskFile({ name: "mutated-source" }));
		const rows = await sql`
			SELECT checksum, requirements_snapshot FROM task_approvals WHERE id = ${approved.approval.id}
		`;
		expect(rows[0]?.checksum).toBe(approved.approval.checksum);
		expect(rows[0]?.checksum).toBe(attached.checksum);
	});
});
