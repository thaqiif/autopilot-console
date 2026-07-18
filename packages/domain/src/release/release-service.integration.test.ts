/**
 * Release + feature planning services — create, uniqueness, branches,
 * development progress, archive guards, activity/audit atomicity.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	countActiveAttemptsForProject,
	createAdminAccount,
	createDatabaseClient,
	createDevelopmentAttempt,
	createProject,
	createTaskApproval,
	createWorkspace,
	type DatabaseClient,
	type Sql,
} from "../../../database/src/index";
import { generateFeatureBranch } from "../../../shared/src/git/feature-branch";
import { createFeatureService, type FeatureService } from "../feature/feature-service";
import type { ProjectActor } from "../project/project";
import { createReleaseService, type ReleaseService } from "./release-service";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

let client: DatabaseClient;
let sql: Sql;
let workspaceId: string;
let projectAId: string;
let projectBId: string;

const ACTOR: ProjectActor = { actorType: "administrator", actorId: "admin-1" };

function makeReleaseService(sqlOverride: Sql = sql): ReleaseService {
	return createReleaseService({
		sql: sqlOverride,
		now: () => new Date("2026-07-18T12:00:00.000Z"),
	});
}

function makeFeatureService(sqlOverride: Sql = sql): FeatureService {
	return createFeatureService({
		sql: sqlOverride,
		now: () => new Date("2026-07-18T12:00:00.000Z"),
	});
}

async function seedActiveJobForRelease(projectId: string, featureId: string, branchName: string) {
	const admin = await createAdminAccount(sql, {
		username: `a-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$seed",
	});
	const approval = await createTaskApproval(sql, {
		projectId,
		featureId,
		relativeTaskPath: "docs/tasks/f.json",
		checksum: "sha256:x",
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [] },
		approvedByAdminId: admin.id,
	});
	await createDevelopmentAttempt(sql, {
		projectId,
		featureId,
		taskApprovalId: approval.id,
		branchName,
		operationKey: `op-${crypto.randomUUID()}`,
		status: "QUEUED",
	});
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
	const workspace = await createWorkspace(sql);
	workspaceId = workspace.id;
	const a = await createProject(sql, {
		workspaceId,
		name: "Project A",
		slug: "project-a",
		githubOwner: "acme",
		githubRepo: "project-a",
		canonicalPath: "/workspaces/project-a",
		developmentBranch: "main",
	});
	const b = await createProject(sql, {
		workspaceId,
		name: "Project B",
		slug: "project-b",
		githubOwner: "acme",
		githubRepo: "project-b",
		canonicalPath: "/workspaces/project-b",
		developmentBranch: "main",
	});
	projectAId = a.id;
	projectBId = b.id;
});

describe("release create and ordering", () => {
	test("creates ordered releases with project-unique name/version, Planned status, UTC timestamps", async () => {
		const service = makeReleaseService();
		const first = await service.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			description: "first ship",
			actor: ACTOR,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("expected ok");
		expect(first.release.projectId).toBe(projectAId);
		expect(first.release.name).toBe("1.0.0");
		expect(first.release.version).toBe("1.0.0");
		expect(first.release.description).toBe("first ship");
		expect(first.release.status).toBe("PLANNED");
		expect(first.release.archivedAt).toBeNull();
		expect(first.release.createdAt.toISOString()).toMatch(/Z$|UTC|\+00:00/);
		expect(first.release.sortOrder).toBe(1);

		const second = await service.createRelease({
			projectId: projectAId,
			name: "1.1.0",
			version: "1.1.0",
			actor: ACTOR,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error("expected ok");
		expect(second.release.sortOrder).toBe(2);
		expect(second.release.description).toBeNull();

		const listed = await service.listReleases({ projectId: projectAId });
		expect(listed.map((r) => r.version)).toEqual(["1.0.0", "1.1.0"]);
	});

	test("rejects project-scoped name/version collisions but allows same version in other projects", async () => {
		const service = makeReleaseService();
		const ok = await service.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		expect(ok.ok).toBe(true);

		const collision = await service.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		expect(collision.ok).toBe(false);
		if (collision.ok) throw new Error("expected fail");
		expect(collision.reason).toBe("UNIQUENESS_VIOLATION");

		const other = await service.createRelease({
			projectId: projectBId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		expect(other.ok).toBe(true);

		const audits = await sql`
			SELECT * FROM audit_events WHERE action = 'release.create' ORDER BY created_at
		`;
		expect(audits.some((a) => a.result === "rejected")).toBe(true);
		expect(audits.some((a) => a.result === "success")).toBe(true);
	});

	test("rejects create for missing project", async () => {
		const service = makeReleaseService();
		const missing = await service.createRelease({
			projectId: crypto.randomUUID(),
			name: "x",
			version: "0.0.1",
			actor: ACTOR,
		});
		expect(missing.ok).toBe(false);
		if (missing.ok) throw new Error("expected fail");
		expect(missing.reason).toBe("NOT_FOUND");
	});
});

describe("feature create and deterministic branch", () => {
	test("creates PLANNED features with project-scoped unique slug and deterministic branch", async () => {
		const releases = makeReleaseService();
		const features = makeFeatureService();
		const release = await releases.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!release.ok) throw new Error("release failed");

		const created = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "Login Flow",
			slug: "login-flow",
			summary: "auth UI",
			actor: ACTOR,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("expected ok");
		expect(created.feature.state).toBe("PLANNED");
		expect(created.feature.slug).toBe("login-flow");
		expect(created.feature.title).toBe("Login Flow");
		expect(created.feature.summary).toBe("auth UI");
		expect(created.feature.taskPath).toBeNull();
		expect(created.feature.projectId).toBe(projectAId);
		expect(created.feature.releaseId).toBe(release.release.id);
		expect(created.feature.branchName).toBe(
			generateFeatureBranch({ featureId: created.feature.id, slug: "login-flow" }),
		);

		const slugCollision = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "Other",
			slug: "login-flow",
			actor: ACTOR,
		});
		expect(slugCollision.ok).toBe(false);
		if (slugCollision.ok) throw new Error("expected fail");
		expect(slugCollision.reason).toBe("UNIQUENESS_VIOLATION");

		// same slug allowed in other project
		const releaseB = await releases.createRelease({
			projectId: projectBId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!releaseB.ok) throw new Error("release B failed");
		const otherProject = await features.createFeature({
			projectId: projectBId,
			releaseId: releaseB.release.id,
			title: "Login Flow",
			slug: "login-flow",
			actor: ACTOR,
		});
		expect(otherProject.ok).toBe(true);
	});

	test("rejects cross-project release/feature association", async () => {
		const releases = makeReleaseService();
		const features = makeFeatureService();
		const releaseA = await releases.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!releaseA.ok) throw new Error("release failed");

		const cross = await features.createFeature({
			projectId: projectBId,
			releaseId: releaseA.release.id,
			title: "Cross",
			slug: "cross",
			actor: ACTOR,
		});
		expect(cross.ok).toBe(false);
		if (cross.ok) throw new Error("expected fail");
		expect(cross.reason).toBe("CROSS_PROJECT");

		const rows = await sql`SELECT count(*)::int AS n FROM features`;
		expect(Number(rows[0]?.n ?? -1)).toBe(0);
	});
});

describe("release development progress and status", () => {
	test("derives development status/progress from non-archived features with development wording", async () => {
		const releases = makeReleaseService();
		const features = makeFeatureService();
		const release = await releases.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!release.ok) throw new Error("release failed");

		const empty = await releases.getReleaseProgress({ releaseId: release.release.id });
		expect(empty.ok).toBe(true);
		if (!empty.ok) throw new Error("expected ok");
		expect(empty.progress.total).toBe(0);
		expect(empty.progress.merged).toBe(0);
		expect(empty.progress.status).toBe("Planned");
		expect(empty.progress.label).toBe("development progress");
		expect(empty.progress.percent).toBe(0);
		expect(JSON.stringify(empty.progress)).not.toMatch(/production|released/i);

		const f1 = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "One",
			slug: "one",
			actor: ACTOR,
		});
		const f2 = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "Two",
			slug: "two",
			actor: ACTOR,
		});
		if (!f1.ok || !f2.ok) throw new Error("features failed");

		// mark one merged via direct SQL (state machine not under test here)
		await sql`
			UPDATE features SET state = 'DEVELOPMENT_MERGED', updated_at = now()
			WHERE id = ${f1.feature.id}
		`;
		// archive the other so it does not count
		await sql`
			UPDATE features SET archived_at = now(), updated_at = now()
			WHERE id = ${f2.feature.id}
		`;

		const progress = await releases.getReleaseProgress({ releaseId: release.release.id });
		expect(progress.ok).toBe(true);
		if (!progress.ok) throw new Error("expected ok");
		expect(progress.progress.total).toBe(1);
		expect(progress.progress.merged).toBe(1);
		expect(progress.progress.status).toBe("Development Merged");
		expect(progress.progress.label).toBe("development progress");
		expect(progress.progress.percent).toBe(100);
	});
});

describe("release archive guards", () => {
	test("blocks archive when release has queued or active feature job", async () => {
		const releases = makeReleaseService();
		const features = makeFeatureService();
		const release = await releases.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!release.ok) throw new Error("release failed");
		const feature = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "Job",
			slug: "job",
			actor: ACTOR,
		});
		if (!feature.ok) throw new Error("feature failed");
		await seedActiveJobForRelease(projectAId, feature.feature.id, feature.feature.branchName);
		expect(await countActiveAttemptsForProject(sql, projectAId)).toBe(1);

		const blocked = await releases.archiveRelease({
			releaseId: release.release.id,
			actor: ACTOR,
		});
		expect(blocked.ok).toBe(false);
		if (blocked.ok) throw new Error("expected fail");
		expect(blocked.reason).toBe("ACTIVE_JOBS");

		const still = await sql`SELECT archived_at FROM releases WHERE id = ${release.release.id}`;
		expect(still[0]?.archived_at).toBeNull();
	});

	test("archives release when no active jobs and retains history", async () => {
		const releases = makeReleaseService();
		const features = makeFeatureService();
		const release = await releases.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!release.ok) throw new Error("release failed");
		const feature = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "Keep",
			slug: "keep",
			actor: ACTOR,
		});
		if (!feature.ok) throw new Error("feature failed");

		const archived = await releases.archiveRelease({
			releaseId: release.release.id,
			actor: ACTOR,
		});
		expect(archived.ok).toBe(true);
		if (!archived.ok) throw new Error("expected ok");
		expect(archived.release.archivedAt).not.toBeNull();

		const featureRows = await sql`SELECT * FROM features WHERE id = ${feature.feature.id}`;
		expect(featureRows.length).toBe(1);
		const releaseRows = await sql`SELECT * FROM releases WHERE id = ${release.release.id}`;
		expect(releaseRows.length).toBe(1);
		expect(releaseRows[0]?.archived_at).not.toBeNull();
	});
});

describe("activity and audit atomicity", () => {
	test("create release records audit and activity in same transaction", async () => {
		const service = makeReleaseService();
		const created = await service.createRelease({
			projectId: projectAId,
			name: "2.0.0",
			version: "2.0.0",
			actor: ACTOR,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("expected ok");

		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_type = 'release' AND target_id = ${created.release.id}
		`;
		expect(audits.length).toBe(1);
		expect(audits[0]?.action).toBe("release.create");
		expect(audits[0]?.result).toBe("success");

		const activity = await sql`
			SELECT * FROM activity_events
			WHERE type = 'release.created' AND project_id = ${projectAId}
		`;
		expect(activity.length).toBe(1);
		expect(String(activity[0]?.summary ?? "")).toMatch(/2\.0\.0/);
	});

	test("create feature records audit and activity; rolls back both on audit failure", async () => {
		const releases = makeReleaseService();
		const release = await releases.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!release.ok) throw new Error("release failed");

		const features = makeFeatureService();
		const ok = await features.createFeature({
			projectId: projectAId,
			releaseId: release.release.id,
			title: "Audit Me",
			slug: "audit-me",
			actor: ACTOR,
		});
		expect(ok.ok).toBe(true);
		if (!ok.ok) throw new Error("expected ok");

		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_type = 'feature' AND target_id = ${ok.feature.id}
		`;
		expect(audits.some((a) => a.action === "feature.create" && a.result === "success")).toBe(true);
		const activity = await sql`
			SELECT * FROM activity_events WHERE type = 'feature.created'
		`;
		expect(activity.length).toBe(1);

		// force audit failure mid-transaction
		const brokenSql = new Proxy(sql, {
			get(target, prop, receiver) {
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								apply(t, thisArg, args) {
									const first = String(args[0]?.[0] ?? args[0] ?? "");
									if (first.includes("INSERT INTO audit_events")) {
										throw new Error("forced audit failure");
									}
									return Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args);
								},
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const broken = makeFeatureService(brokenSql);
		await expect(
			broken.createFeature({
				projectId: projectAId,
				releaseId: release.release.id,
				title: "Rollback",
				slug: "rollback-feature",
				actor: ACTOR,
			}),
		).rejects.toThrow(/forced audit failure/);

		const leftover = await sql`SELECT * FROM features WHERE slug = 'rollback-feature'`;
		expect(leftover.length).toBe(0);
		const activityAfter = await sql`
			SELECT * FROM activity_events WHERE type = 'feature.created'
		`;
		expect(activityAfter.length).toBe(1);
	});

	test("update release emits audit/activity; validation rejection is audited", async () => {
		const service = makeReleaseService();
		const created = await service.createRelease({
			projectId: projectAId,
			name: "1.0.0",
			version: "1.0.0",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const updated = await service.updateRelease({
			releaseId: created.release.id,
			name: "1.0.0-rc",
			description: "updated",
			actor: ACTOR,
		});
		expect(updated.ok).toBe(true);
		if (!updated.ok) throw new Error("expected ok");
		expect(updated.release.name).toBe("1.0.0-rc");
		expect(updated.release.description).toBe("updated");

		const emptyName = await service.updateRelease({
			releaseId: created.release.id,
			name: "   ",
			actor: ACTOR,
		});
		expect(emptyName.ok).toBe(false);
		if (emptyName.ok) throw new Error("expected fail");
		expect(emptyName.reason).toBe("VALIDATION_FAILED");

		const audits = await sql`
			SELECT * FROM audit_events
			WHERE target_type = 'release' AND target_id = ${created.release.id}
			ORDER BY created_at
		`;
		expect(audits.some((a) => a.action === "release.update" && a.result === "success")).toBe(true);
		expect(audits.some((a) => a.action === "release.update" && a.result === "rejected")).toBe(true);
	});
});
