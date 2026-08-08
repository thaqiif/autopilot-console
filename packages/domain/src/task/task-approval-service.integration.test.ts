/**
 * RED: task attach, immutable approval, atomic Approve & Queue Development.
 * Fails until task-approval-service is implemented.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
	DATABASE_URL,
	type DatabaseClient,
	getFeatureById,
	resetSchema,
	type Sql,
	updateAttemptStatus,
	updateFeature,
} from "../../../database/src/index";
import type { ProjectActor } from "../project/project";
import {
	createTaskApprovalService,
	type TaskApprovalService,
	type TaskArtifactFailureReason,
} from "./task-approval-service";

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

/**
 * Proxy a postgres.js Sql that intercepts tagged-template queries whose text
 * matches `matchSql`. Optional transformSelect rewrites selected SELECTs.
 */
function sqlThrowingOn(
	base: Sql,
	matchSql: RegExp,
	errorFactory: () => Error,
	options?: {
		transformSelect?: (
			text: string,
			args: unknown[],
			run: () => Promise<unknown>,
		) => Promise<unknown>;
	},
): Sql {
	const wrap = (target: Sql): Sql => {
		const apply = (_t: Sql, _thisArg: unknown, argArray: unknown[]) => {
			const strings = argArray[0] as TemplateStringsArray | string | undefined;
			const text = Array.isArray(strings) ? strings.join(" ") : String(strings ?? "");
			const args = argArray.slice(1);
			const run = () =>
				Reflect.apply(target as unknown as (...a: unknown[]) => unknown, target, argArray);
			if (matchSql.test(text)) {
				throw errorFactory();
			}
			if (options?.transformSelect && /SELECT/i.test(text)) {
				return options.transformSelect(text, args, () => Promise.resolve(run()));
			}
			return run();
		};
		return new Proxy(target, {
			apply,
			get(t, p, r) {
				if (p === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) =>
						(t as Sql).begin(async (tx) => fn(wrap(tx as unknown as Sql)));
				}
				if (p === "json") {
					const v = Reflect.get(t, p, r);
					return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
				}
				const v = Reflect.get(t, p, r);
				return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
			},
		}) as unknown as Sql;
	};
	return wrap(base);
}

function sqlTransformingQueries(
	base: Sql,
	transform: (text: string, args: unknown[], run: () => Promise<unknown>) => Promise<unknown>,
): Sql {
	const wrap = (target: Sql): Sql =>
		new Proxy(target, {
			apply(_target, _thisArg, argArray) {
				const strings = argArray[0] as TemplateStringsArray | string | undefined;
				const text = Array.isArray(strings) ? strings.join(" ") : String(strings ?? "");
				const args = argArray.slice(1);
				const run = () =>
					Promise.resolve(
						Reflect.apply(target as unknown as (...values: unknown[]) => unknown, target, argArray),
					);
				return transform(text, args, run);
			},
			get(targetObject, property, receiver) {
				if (property === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) =>
						(targetObject as Sql).begin(async (tx) => fn(wrap(tx as unknown as Sql)));
				}
				const value = Reflect.get(targetObject, property, receiver);
				return typeof value === "function" ? value.bind(targetObject) : value;
			},
		}) as unknown as Sql;
	return wrap(base);
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
	const suffix = crypto.randomUUID().slice(0, 8);
	const release = await createRelease(sql, {
		projectId,
		name: `1.0.0-${suffix}`,
		version: `1.0.0-${suffix}`,
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

async function prepareAttachedFeature(fileName: string) {
	const feature = await seedFeature();
	const task = await writeTask(`docs/tasks/${fileName}.json`, fullTaskFile());
	const attached = await makeService().attachTask({
		featureId: feature.id,
		relativeTaskPath: task.relative,
		actor: actor(),
	});
	if (!attached.ok) throw new Error("attach failed");
	return { feature, task, attached };
}

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await resetSchema(sql);
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

describe("replaceTask coverage edges", () => {
	test("replaceTask invalidates prior approval and attaches replacement with idempotent replay", async () => {
		const service = makeService();
		const feature = await seedFeature();
		const first = await writeTask("docs/tasks/first.json", {
			name: "first",
			description: "first",
			goals: ["g"],
			nonGoals: [],
			requirements: [{ id: "1", description: "one", acceptance: ["a"], passes: false }],
		});
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: first.relative,
			actor: actor(),
		});
		expect(attached.ok).toBe(true);
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-${feature.id}-replace`,
			actor: actor(),
		});
		expect(approved.ok).toBe(true);
		if (!approved.ok) throw new Error("approve failed");

		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		await sql`
			UPDATE development_job_attempts
			SET status = 'FAILED', ended_at = now()
			WHERE feature_id = ${feature.id}
		`;

		const second = await writeTask("docs/tasks/second.json", {
			name: "second",
			description: "second",
			goals: ["g"],
			nonGoals: [],
			requirements: [
				{ id: "1", description: "one", acceptance: ["a"], passes: false },
				{ id: "2", description: "two", acceptance: ["b"], passes: false },
			],
		});
		const opKey = `replace-${feature.id}-1`;
		const replaced = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			relativeTaskPath: second.relative,
			operationKey: opKey,
			actor: actor(),
		});
		expect(replaced.ok).toBe(true);
		if (!replaced.ok) throw new Error(`replace failed: ${replaced.reason} ${replaced.message}`);
		expect(replaced.idempotent).toBe(false);
		expect(replaced.invalidatedApprovalId).toBe(approved.approval.id);

		const replay = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			relativeTaskPath: second.relative,
			operationKey: opKey,
			actor: actor(),
		});
		expect(replay.ok).toBe(true);
		if (!replay.ok) throw new Error("replay failed");
		expect(replay.idempotent).toBe(true);
	});

	test("replaceTask rejects wrong project, illegal state, and mismatched idempotency payload", async () => {
		const service = makeService();
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/edge.json", {
			name: "edge",
			description: "edge",
			goals: ["g"],
			nonGoals: [],
			requirements: [{ id: "1", description: "one", acceptance: ["a"], passes: false }],
		});
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-${feature.id}-edge`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");

		const wrongProject = await service.replaceTask({
			featureId: feature.id,
			projectId: crypto.randomUUID(),
			approvalId: approved.approval.id,
			relativeTaskPath: task.relative,
			operationKey: `replace-wrong-${feature.id}`,
			actor: actor(),
		});
		expect(wrongProject.ok).toBe(false);

		const illegal = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			relativeTaskPath: task.relative,
			operationKey: `replace-illegal-${feature.id}`,
			actor: actor(),
		});
		expect(illegal.ok).toBe(false);

		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		const second = await writeTask("docs/tasks/edge2.json", {
			name: "edge2",
			description: "edge2",
			goals: ["g"],
			nonGoals: [],
			requirements: [{ id: "1", description: "one", acceptance: ["a"], passes: false }],
		});
		const op = `replace-conflict-${feature.id}`;
		const first = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			relativeTaskPath: second.relative,
			operationKey: op,
			actor: actor(),
		});
		expect(first.ok).toBe(true);
		const mismatched = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: crypto.randomUUID(),
			relativeTaskPath: second.relative,
			operationKey: op,
			actor: actor(),
		});
		expect(mismatched.ok).toBe(false);
	});
});

describe("tiny remaining coverage edges", () => {
	test("default clock and omitted project scope preserve approval behavior", async () => {
		const { feature, attached } = await prepareAttachedFeature("default-clock");
		const service = createTaskApprovalService({ sql });
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			displayedChecksum: attached.checksum,
			operationKey: `approve-default-clock-${feature.id}`,
			actor: actor(),
		});
		expect(approved.ok).toBe(true);
		if (!approved.ok) throw new Error("approve failed");
		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		const invalidated = await service.invalidateApproval({
			featureId: feature.id,
			approvalId: approved.approval.id,
			actor: actor(),
		});
		expect(invalidated.ok).toBe(true);
	});

	test("approveAndQueue rejects a task changed to invalid JSON after review", async () => {
		const { feature, task, attached } = await prepareAttachedFeature("changed-invalid");
		await writeFile(task.absolute, "{ invalid json", "utf8");
		const result = await makeService().approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-invalid-json-${feature.id}`,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("VALIDATION_FAILED");
	});

	test("approveAndQueue observes a same-key winner after taking the feature lock", async () => {
		const { feature, attached } = await prepareAttachedFeature("locked-winner");
		const operationKey = `locked-winner-${feature.id}`;
		const first = await makeService().approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey,
			actor: actor(),
		});
		if (!first.ok) throw new Error("approve failed");
		await sql`UPDATE features SET state = 'TASKS_REVIEW' WHERE id = ${feature.id}`;

		let hideOuterRead = true;
		const racingSql = sqlTransformingQueries(sql, async (text, args, run) => {
			if (
				hideOuterRead &&
				/FROM\s+idempotency_records/i.test(text) &&
				args.includes(operationKey)
			) {
				hideOuterRead = false;
				return [];
			}
			return run();
		});
		const replay = await createTaskApprovalService({ sql: racingSql }).approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey,
			actor: actor(),
		});
		expect(replay.ok).toBe(true);
		if (replay.ok) expect(replay.idempotent).toBe(true);
	});

	test("approveAndQueue returns stable errors for feature changes under its lock", async () => {
		const cases: Array<{
			name: string;
			mutate: (row: Record<string, unknown>) => Record<string, unknown> | null;
			reason: TaskArtifactFailureReason;
		}> = [
			{ name: "deleted", mutate: () => null, reason: "FEATURE_NOT_FOUND" },
			{
				name: "moved-project",
				mutate: (row) => ({ ...row, project_id: crypto.randomUUID() }),
				reason: "NOT_FOUND",
			},
			{
				name: "state-changed",
				mutate: (row) => ({ ...row, state: "DEVELOPING" }),
				reason: "ILLEGAL_STATE",
			},
			{
				name: "task-removed",
				mutate: (row) => ({ ...row, task_path: null }),
				reason: "VALIDATION_FAILED",
			},
		];

		for (const rowCase of cases) {
			const { feature, attached } = await prepareAttachedFeature(`locked-${rowCase.name}`);
			let featureReadCount = 0;
			let transformed = false;
			const racingSql = sqlTransformingQueries(sql, async (text, _args, run) => {
				if (/SELECT\s+\*\s+FROM\s+features\b/i.test(text)) featureReadCount += 1;
				if (featureReadCount === 2 && !transformed) {
					transformed = true;
					const rows = (await run()) as Array<Record<string, unknown>>;
					const changed = rows[0] ? rowCase.mutate(rows[0]) : null;
					return changed ? [changed] : [];
				}
				return run();
			});
			const result = await createTaskApprovalService({ sql: racingSql }).approveAndQueue({
				featureId: feature.id,
				projectId,
				displayedChecksum: attached.checksum,
				operationKey: `approve-locked-${rowCase.name}-${feature.id}`,
				actor: actor(),
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe(rowCase.reason);
		}
	});

	test("approveAndQueue detects an optimistic update lost under its lock", async () => {
		const { feature, attached } = await prepareAttachedFeature("lost-update");
		const racingSql = sqlTransformingQueries(sql, async (text, _args, run) => {
			if (/UPDATE\s+features[\s\S]+SET\s+state/i.test(text)) return [];
			return run();
		});
		const result = await createTaskApprovalService({ sql: racingSql }).approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-lost-update-${feature.id}`,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("ILLEGAL_STATE");
	});

	test("approveAndQueue retains the locked feature snapshot if the final reload is absent", async () => {
		const { feature, attached } = await prepareAttachedFeature("missing-final-reload");
		let featureReadCount = 0;
		const racingSql = sqlTransformingQueries(sql, async (text, _args, run) => {
			if (/SELECT\s+\*\s+FROM\s+features\b/i.test(text)) {
				featureReadCount += 1;
				if (featureReadCount === 3) return [];
			}
			return run();
		});
		const result = await createTaskApprovalService({ sql: racingSql }).approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-missing-final-reload-${feature.id}`,
			actor: actor(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.feature.id).toBe(feature.id);
			expect(result.attempt.featureId).toBe(feature.id);
		}
	});

	test("replaceTask validates project availability and replacement contents", async () => {
		const prepareFailedAttempt = async (name: string) => {
			const prepared = await prepareAttachedFeature(name);
			const approved = await makeService().approveAndQueue({
				featureId: prepared.feature.id,
				projectId,
				displayedChecksum: prepared.attached.checksum,
				operationKey: `approve-${name}-${prepared.feature.id}`,
				actor: actor(),
			});
			if (!approved.ok) throw new Error("approve failed");
			await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${prepared.feature.id}`;
			await sql`
				UPDATE development_job_attempts SET status = 'FAILED', ended_at = now()
				WHERE feature_id = ${prepared.feature.id}
			`;
			return { ...prepared, approved };
		};

		const missingProject = await prepareFailedAttempt("replace-missing-project");
		const replacement = await writeTask("docs/tasks/replacement-valid.json", fullTaskFile());
		const hiddenProjectSql = sqlTransformingQueries(sql, async (text, _args, run) =>
			/FROM\s+projects\b/i.test(text) ? [] : run(),
		);
		const missing = await createTaskApprovalService({ sql: hiddenProjectSql }).replaceTask({
			featureId: missingProject.feature.id,
			projectId,
			approvalId: missingProject.approved.approval.id,
			relativeTaskPath: replacement.relative,
			operationKey: `replace-project-missing-${missingProject.feature.id}`,
			actor: actor(),
		});
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("NOT_FOUND");

		const invalidContents = await prepareFailedAttempt("replace-invalid-contents");
		const invalid = join(projectPath, "docs/tasks/replacement-invalid.json");
		await writeFile(invalid, "not json", "utf8");
		const invalidResult = await makeService().replaceTask({
			featureId: invalidContents.feature.id,
			projectId,
			approvalId: invalidContents.approved.approval.id,
			relativeTaskPath: "docs/tasks/replacement-invalid.json",
			operationKey: `replace-invalid-${invalidContents.feature.id}`,
			actor: actor(),
		});
		expect(invalidResult.ok).toBe(false);
		if (!invalidResult.ok) expect(invalidResult.reason).toBe("VALIDATION_FAILED");
	});

	test("approveAndQueue rejects feature without attached task path", async () => {
		const service = makeService();
		const feature = await seedFeature("TASKS_REVIEW");
		const result = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: "deadbeef",
			operationKey: `approve-notask-${feature.id}`,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("VALIDATION_FAILED");
	});

	test("invalidateApproval rejects missing feature and project mismatch", async () => {
		const service = makeService();
		const missing = await service.invalidateApproval({
			featureId: crypto.randomUUID(),
			projectId,
			approvalId: crypto.randomUUID(),
			actor: actor(),
		});
		expect(missing.ok).toBe(false);

		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/inv.json", {
			name: "inv",
			description: "inv",
			goals: ["g"],
			nonGoals: [],
			requirements: [{ id: "1", description: "one", acceptance: ["a"], passes: false }],
		});
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-inv-${feature.id}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");
		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		const mismatch = await service.invalidateApproval({
			featureId: feature.id,
			projectId: crypto.randomUUID(),
			approvalId: approved.approval.id,
			actor: actor(),
		});
		expect(mismatch.ok).toBe(false);
	});

	test("attachTask rejects unreadable task files", async () => {
		const service = makeService();
		const feature = await seedFeature();
		// Create a directory at the path so open as file fails
		const relative = "docs/tasks/not-a-file.json";
		await mkdir(join(projectPath, relative), { recursive: true });
		const result = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: relative,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
	});

	test("removeTask rejects missing feature", async () => {
		const service = makeService();
		const result = await service.removeTask({
			featureId: crypto.randomUUID(),
			actor: actor(),
		});
		expect(result.ok).toBe(false);
	});

	test("attachTask rejects missing feature id", async () => {
		const service = makeService();
		const result = await service.attachTask({
			featureId: crypto.randomUUID(),
			relativeTaskPath: "docs/tasks/missing-feature.json",
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("FEATURE_NOT_FOUND");
	});

	test("attachTask maps unreadable file open failures", async () => {
		const service = makeService();
		const feature = await seedFeature();
		const relative = "docs/tasks/unreadable.json";
		const absolute = join(projectPath, relative);
		await mkdir(join(absolute, ".."), { recursive: true });
		await writeFile(absolute, `${JSON.stringify(minimalTaskFile())}\n`, "utf8");
		await chmod(absolute, 0o000);
		try {
			const result = await service.attachTask({
				featureId: feature.id,
				relativeTaskPath: relative,
				actor: actor(),
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("VALIDATION_FAILED");
		} finally {
			await chmod(absolute, 0o644);
		}
	});

	test("approveAndQueue covers missing feature, project mismatch, and corrupt idempotency cache", async () => {
		const service = makeService();
		const missing = await service.approveAndQueue({
			featureId: crypto.randomUUID(),
			projectId,
			displayedChecksum: "deadbeef",
			operationKey: `approve-missing-${crypto.randomUUID()}`,
			actor: actor(),
		});
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("FEATURE_NOT_FOUND");

		const feature = await seedFeature("TASKS_REVIEW");
		const mismatch = await service.approveAndQueue({
			featureId: feature.id,
			projectId: crypto.randomUUID(),
			displayedChecksum: "deadbeef",
			operationKey: `approve-mismatch-${feature.id}`,
			actor: actor(),
		});
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) expect(mismatch.reason).toBe("NOT_FOUND");

		const task = await writeTask("docs/tasks/cache-edge.json", fullTaskFile());
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const opKey = `approve-cache-${feature.id}`;
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");

		// Corrupt cache → does not treat incomplete payload as an idempotent success.
		await sql`
			UPDATE idempotency_records
			SET result = ${sql.json({ incomplete: true })}
			WHERE operation_key = ${opKey}
		`;
		const corrupt = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		expect(corrupt.ok).toBe(false);

		// Restore valid cache shape then request with wrong project → NOT_FOUND.
		await sql`
			UPDATE idempotency_records
			SET result = ${sql.json({
				approval: approved.approval,
				attempt: approved.attempt,
			} as never)}
			WHERE operation_key = ${opKey}
		`;
		const cachedMismatch = await service.approveAndQueue({
			featureId: feature.id,
			projectId: crypto.randomUUID(),
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		expect(cachedMismatch.ok).toBe(false);
		if (!cachedMismatch.ok) expect(cachedMismatch.reason).toBe("NOT_FOUND");

		// Cache hit with a non-existent feature id → FEATURE_NOT_FOUND without mutating history.
		const cachedMissingFeature = await service.approveAndQueue({
			featureId: crypto.randomUUID(),
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		expect(cachedMissingFeature.ok).toBe(false);
		if (!cachedMissingFeature.ok) expect(cachedMissingFeature.reason).toBe("FEATURE_NOT_FOUND");
	});

	test("invalidateApproval rejects already-invalidated approval ids", async () => {
		const service = makeService();
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/inv-twice.json", fullTaskFile());
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-inv-twice-${feature.id}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");
		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		const first = await service.invalidateApproval({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			actor: actor(),
		});
		expect(first.ok).toBe(true);
		await expect(
			service.invalidateApproval({
				featureId: feature.id,
				projectId,
				approvalId: approved.approval.id,
				actor: actor(),
			}),
		).rejects.toThrow(/not found or already invalidated/i);
	});

	test("replaceTask rejects missing active approval", async () => {
		const service = makeService();
		const feature = await seedFeature();
		const first = await writeTask("docs/tasks/replace-a.json", fullTaskFile());
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: first.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-replace-missing-${feature.id}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");
		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		await sql`
			UPDATE development_job_attempts
			SET status = 'FAILED', ended_at = now()
			WHERE feature_id = ${feature.id}
		`;
		const second = await writeTask("docs/tasks/replace-b.json", {
			name: "second",
			description: "second",
			goals: ["g"],
			nonGoals: [],
			requirements: [
				{ id: "1", description: "one", acceptance: ["a"], passes: false },
				{ id: "2", description: "two", acceptance: ["b"], passes: false },
			],
		});
		const missingApproval = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: crypto.randomUUID(),
			relativeTaskPath: second.relative,
			operationKey: `replace-missing-approval-${feature.id}`,
			actor: actor(),
		});
		expect(missingApproval.ok).toBe(false);
		if (!missingApproval.ok) expect(missingApproval.reason).toBe("NOT_FOUND");
	});

	test("approveAndQueue recovers from unique-violation races via cached winner", async () => {
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/approve-race.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const opKey = `approve-unique-race-${feature.id}`;
		const first = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		if (!first.ok) throw new Error("first approve failed");

		// Hide only the first two idempotency SELECTs (outer + locked). Subsequent recovery
		// re-reads must see the winner. Throw 23505 on attempt insert path by forcing a
		// unique collision via the still-active attempt with the same operation key.
		let hideCount = 2;
		const racingSql = sqlThrowingOn(
			sql,
			// Never match inserts — let real unique constraints fire from the still-active attempt.
			/NEVER_MATCH_THIS_INSERT/i,
			() => new Error("unused"),
			{
				transformSelect: (text, args, run) => {
					if (hideCount > 0 && /FROM\s+idempotency_records/i.test(text) && args.includes(opKey)) {
						hideCount -= 1;
						return Promise.resolve([]);
					}
					return run();
				},
			},
		);
		// Keep feature in TASKS_REVIEW with attached task so approve re-enters write path;
		// the existing attempt with the same operation_key collides and triggers recovery.
		await sql`UPDATE features SET state = 'TASKS_REVIEW' WHERE id = ${feature.id}`;
		const recovered = await createTaskApprovalService({
			sql: racingSql,
			now: () => new Date("2026-07-18T15:00:00.000Z"),
		}).approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: opKey,
			actor: actor(),
		});
		expect(recovered.ok).toBe(true);
		if (recovered.ok) {
			expect(recovered.idempotent).toBe(true);
			expect(recovered.attempt.id).toBe(first.attempt.id);
		}
	});

	test("approveAndQueue unique-violation without winner returns ILLEGAL_STATE", async () => {
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/approve-orphan.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const orphanKey = `approve-orphan-race-${feature.id}`;
		// No pre-existing idempotency row for orphanKey — INSERT throws 23505, recovery finds nothing.
		const orphanSql = sqlThrowingOn(sql, /INSERT\s+INTO\s+idempotency_records/i, () => {
			const err = new Error("duplicate key value violates unique constraint");
			(err as { code?: string }).code = "23505";
			return err;
		});
		const orphaned = await createTaskApprovalService({
			sql: orphanSql,
			now: () => new Date("2026-07-18T15:00:00.000Z"),
		}).approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: orphanKey,
			actor: actor(),
		});
		expect(orphaned.ok).toBe(false);
		if (!orphaned.ok) expect(orphaned.reason).toBe("ILLEGAL_STATE");
	});

	test("replaceTask recovers from unique-violation races via cached winner", async () => {
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/replace-race-a.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-replace-race-${feature.id}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");
		await sql`UPDATE features SET state = 'DEVELOPMENT_FAILED' WHERE id = ${feature.id}`;
		await sql`
			UPDATE development_job_attempts
			SET status = 'FAILED', ended_at = now()
			WHERE feature_id = ${feature.id}
		`;
		const replacement = await writeTask("docs/tasks/replace-race-b.json", {
			name: "replacement",
			description: "replacement",
			goals: ["g"],
			nonGoals: [],
			requirements: [{ id: "1", description: "one", acceptance: ["a"], passes: false }],
		});
		const raceKey = `replace-unique-race-${feature.id}`;
		await sql`
			INSERT INTO idempotency_records (operation_key, project_id, feature_id, result)
			VALUES (
				${raceKey},
				${projectId},
				${feature.id},
				${sql.json({
					kind: "task.replace",
					approvalId: approved.approval.id,
					checksum: "cached-checksum",
					summary: {
						name: "cached",
						description: "cached",
						requirementCount: 1,
						requirements: [],
					},
				})}
			)
		`;
		let blockIdempotencyReads = true;
		const racingSql = sqlThrowingOn(
			sql,
			/INSERT\s+INTO\s+idempotency_records/i,
			() => {
				blockIdempotencyReads = false;
				const err = new Error(
					'duplicate key value violates unique constraint "idempotency_records_pkey"',
				);
				(err as { code?: string }).code = "23505";
				return err;
			},
			{
				transformSelect: (text, args, run) => {
					if (
						blockIdempotencyReads &&
						/FROM\s+idempotency_records/i.test(text) &&
						args.includes(raceKey)
					) {
						return Promise.resolve([]);
					}
					return run();
				},
			},
		);
		const recovered = await createTaskApprovalService({
			sql: racingSql,
			now: () => new Date("2026-07-18T15:00:00.000Z"),
		}).replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			relativeTaskPath: replacement.relative,
			operationKey: raceKey,
			actor: actor(),
		});
		expect(recovered.ok).toBe(true);
		if (recovered.ok) {
			expect(recovered.idempotent).toBe(true);
			expect(recovered.checksum).toBe("cached-checksum");
		}
	});

	test("replaceTask rejects incomplete cached idempotency payloads", async () => {
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/replace-incomplete.json", fullTaskFile());
		const service = makeService();
		const attached = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approved = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-incomplete-${feature.id}`,
			actor: actor(),
		});
		if (!approved.ok) throw new Error("approve failed");
		const opKey = `replace-incomplete-${feature.id}`;
		await sql`
			INSERT INTO idempotency_records (operation_key, project_id, feature_id, result)
			VALUES (
				${opKey},
				${projectId},
				${feature.id},
				${sql.json({
					kind: "task.replace",
					approvalId: approved.approval.id,
					// checksum/summary intentionally omitted
				})}
			)
		`;
		const result = await service.replaceTask({
			featureId: feature.id,
			projectId,
			approvalId: approved.approval.id,
			relativeTaskPath: task.relative,
			operationKey: opKey,
			actor: actor(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("NOT_FOUND");
	});

	test("attachTask and approveAndQueue report missing project rows", async () => {
		const feature = await seedFeature();
		const task = await writeTask("docs/tasks/missing-project.json", fullTaskFile());
		const missingProjectSql = sqlThrowingOn(sql, /NEVER_MATCH_INSERT/i, () => new Error("unused"), {
			transformSelect: (text, _args, run) => {
				if (/FROM\s+projects\b/i.test(text)) {
					return Promise.resolve([]);
				}
				return run();
			},
		});
		const service = createTaskApprovalService({
			sql: missingProjectSql,
			now: () => new Date("2026-07-18T15:00:00.000Z"),
		});
		const attach = await service.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		expect(attach.ok).toBe(false);
		if (!attach.ok) expect(attach.reason).toBe("NOT_FOUND");

		// Real attach first so approve path can reach project lookup with task attached.
		const real = makeService();
		const attached = await real.attachTask({
			featureId: feature.id,
			relativeTaskPath: task.relative,
			actor: actor(),
		});
		if (!attached.ok) throw new Error("attach failed");
		const approve = await service.approveAndQueue({
			featureId: feature.id,
			projectId,
			displayedChecksum: attached.checksum,
			operationKey: `approve-missing-project-${feature.id}`,
			actor: actor(),
		});
		expect(approve.ok).toBe(false);
		if (!approve.ok) expect(approve.reason).toBe("NOT_FOUND");
	});
});
