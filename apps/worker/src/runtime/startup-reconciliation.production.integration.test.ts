import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
	createWorkspace,
	type DatabaseClient,
	type Sql,
} from "../../../../packages/database/src/index";
import { reconcileOrphansAtWorkerStartup } from "../main";

const ADMIN_DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";
const NOW = new Date("2026-07-19T12:00:00.000Z");

let adminClient: DatabaseClient;
let client: DatabaseClient;
let sql: Sql;
let databaseName: string;

function databaseUrlFor(name: string): string {
	const url = new URL(ADMIN_DATABASE_URL);
	url.pathname = `/${name}`;
	return url.toString();
}

async function seedExpiredOrphan(): Promise<{ attemptId: string; featureId: string }> {
	const workspace = await createWorkspace(sql);
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID()}`,
		passwordHash: "test-password-hash",
	});
	const suffix = crypto.randomUUID();
	const project = await createProject(sql, {
		workspaceId: workspace.id,
		name: `Orphan Project ${suffix}`,
		slug: `orphan-project-${suffix}`,
		githubOwner: "example",
		githubRepo: `orphan-${suffix}`,
		canonicalPath: `/workspaces/orphan-${suffix}`,
		developmentBranch: "main",
	});
	const release = await createRelease(sql, {
		projectId: project.id,
		name: "Orphan release",
		version: "1.0.0",
		sortOrder: 1,
	});
	const branchName = `feature/${suffix}-orphan`;
	const feature = await createFeature(sql, {
		projectId: project.id,
		releaseId: release.id,
		slug: `orphan-${suffix}`,
		title: "Recover orphaned development",
		branchName,
		state: "DEVELOPING",
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/orphan.json",
		checksum: `sha256:${suffix}`,
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [] },
		approvedByAdminId: admin.id,
	});
	const attempt = await createDevelopmentAttempt(sql, {
		projectId: project.id,
		featureId: feature.id,
		taskApprovalId: approval.id,
		branchName,
		operationKey: `development:${suffix}`,
		status: "RUNNING",
		leaseExpiresAt: new Date(NOW.getTime() - 1_000),
		heartbeatAt: new Date(NOW.getTime() - 31_000),
	});
	return { attemptId: attempt.id, featureId: feature.id };
}

beforeAll(async () => {
	adminClient = createDatabaseClient(ADMIN_DATABASE_URL);
	databaseName = `worker_startup_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
	await adminClient.sql.unsafe(`CREATE DATABASE "${databaseName}"`);
	client = createDatabaseClient(databaseUrlFor(databaseName));
	sql = client.sql;
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			failure_records,
			activity_events,
			audit_events,
			development_job_attempts,
			task_approvals,
			features,
			releases,
			projects,
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

describe("worker startup orphan reconciliation", () => {
	test("uses the full reconciler for an expired running attempt", async () => {
		const seed = await seedExpiredOrphan();

		const count = await reconcileOrphansAtWorkerStartup(sql, { now: () => NOW });

		expect(count).toBe(1);
		const [state] = await sql`
			SELECT
				(SELECT status FROM development_job_attempts WHERE id = ${seed.attemptId}) AS attempt_status,
				(SELECT state FROM features WHERE id = ${seed.featureId}) AS feature_state,
				(SELECT count(*)::int FROM failure_records WHERE attempt_id = ${seed.attemptId}) AS failures,
				(SELECT count(*)::int FROM activity_events WHERE attempt_id = ${seed.attemptId}) AS activity,
				(SELECT count(*)::int FROM audit_events WHERE attempt_id = ${seed.attemptId}) AS audit
		`;
		expect(state).toMatchObject({
			attempt_status: "INTERRUPTED",
			feature_state: "DEVELOPMENT_INTERRUPTED",
			failures: 1,
			activity: 1,
			audit: 1,
		});
	});

	test("rolls back the complete reconciliation when an audit write fails", async () => {
		const seed = await seedExpiredOrphan();
		await sql.unsafe(`
			CREATE FUNCTION fail_orphan_audit() RETURNS trigger AS $$
			BEGIN
				IF NEW.action = 'development.interrupt' THEN
					RAISE EXCEPTION 'forced orphan audit failure';
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER fail_orphan_audit_insert
				BEFORE INSERT ON audit_events
				FOR EACH ROW EXECUTE FUNCTION fail_orphan_audit();
		`);

		try {
			await expect(reconcileOrphansAtWorkerStartup(sql, { now: () => NOW })).rejects.toThrow(
				"forced orphan audit failure",
			);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS fail_orphan_audit_insert ON audit_events;
				DROP FUNCTION IF EXISTS fail_orphan_audit();
			`);
		}

		const [state] = await sql`
			SELECT
				(SELECT status FROM development_job_attempts WHERE id = ${seed.attemptId}) AS attempt_status,
				(SELECT state FROM features WHERE id = ${seed.featureId}) AS feature_state,
				(SELECT count(*)::int FROM failure_records WHERE attempt_id = ${seed.attemptId}) AS failures,
				(SELECT count(*)::int FROM activity_events WHERE attempt_id = ${seed.attemptId}) AS activity
		`;
		expect(state).toMatchObject({
			attempt_status: "RUNNING",
			feature_state: "DEVELOPING",
			failures: 0,
			activity: 0,
		});
	});
});
