import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	createAdminAccount,
	createDatabaseClient,
	createDevelopmentAttempt,
	createFeature,
	createIdempotencyRecord,
	createProject,
	createRelease,
	createTaskApproval,
	createWorkspace,
	type DatabaseClient,
	type Sql,
} from "../../../../packages/database/src/index";

import { createRetryService, type RetryRequest } from "./retry-service";

const ADMIN_DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

let adminClient: DatabaseClient;
let primaryClient: DatabaseClient;
let concurrentClient: DatabaseClient;
let sql: Sql;
let databaseName: string;

interface RetrySeed {
	featureId: string;
	projectId: string;
	approvalId: string;
	adminId: string;
	branchName: string;
	failedAttemptId: string;
}

function databaseUrlFor(name: string): string {
	const url = new URL(ADMIN_DATABASE_URL);
	url.pathname = `/${name}`;
	return url.toString();
}

async function seedRetryableFeature(): Promise<RetrySeed> {
	const workspace = await createWorkspace(sql);
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID()}`,
		passwordHash: "test-password-hash",
	});
	const suffix = crypto.randomUUID();
	const project = await createProject(sql, {
		workspaceId: workspace.id,
		name: `Retry Project ${suffix}`,
		slug: `retry-project-${suffix}`,
		githubOwner: "example",
		githubRepo: `retry-${suffix}`,
		canonicalPath: `/workspaces/retry-${suffix}`,
		developmentBranch: "main",
	});
	const release = await createRelease(sql, {
		projectId: project.id,
		name: "Retry release",
		version: "1.0.0",
		sortOrder: 1,
	});
	const branchName = `feature/${suffix}-retry`;
	const feature = await createFeature(sql, {
		projectId: project.id,
		releaseId: release.id,
		slug: `retry-${suffix}`,
		title: "Retry production behavior",
		branchName,
		state: "DEVELOPMENT_FAILED",
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/retry.json",
		checksum: `sha256:${suffix}`,
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [] },
		approvedByAdminId: admin.id,
	});
	const failedAttempt = await createDevelopmentAttempt(sql, {
		projectId: project.id,
		featureId: feature.id,
		taskApprovalId: approval.id,
		branchName,
		operationKey: `development:${suffix}`,
		status: "FAILED",
	});

	return {
		featureId: feature.id,
		projectId: project.id,
		approvalId: approval.id,
		adminId: admin.id,
		branchName,
		failedAttemptId: failedAttempt.id,
	};
}

function retryRequest(
	seed: RetrySeed,
	operationKey = `retry:${crypto.randomUUID()}`,
): RetryRequest {
	return {
		featureId: seed.featureId,
		projectId: seed.projectId,
		taskApprovalId: seed.approvalId,
		branchName: seed.branchName,
		operationKey,
		reason: "operator requested a retry",
		actorId: seed.adminId,
	};
}

beforeAll(async () => {
	adminClient = createDatabaseClient(ADMIN_DATABASE_URL);
	databaseName = `retry_service_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
	await adminClient.sql.unsafe(`CREATE DATABASE "${databaseName}"`);

	const testDatabaseUrl = databaseUrlFor(databaseName);
	primaryClient = createDatabaseClient(testDatabaseUrl);
	concurrentClient = createDatabaseClient(testDatabaseUrl);
	sql = primaryClient.sql;
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			idempotency_records,
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
	await primaryClient?.end();
	await concurrentClient?.end();
	if (adminClient && databaseName) {
		await adminClient.sql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
	}
	await adminClient?.end();
}, 30_000);

describe("production retry service", () => {
	test("atomically queues the feature and records the retry", async () => {
		const seed = await seedRetryableFeature();
		const outcome = await createRetryService({ sql }).retry(retryRequest(seed));

		expect(outcome.kind).toBe("retried");
		if (outcome.kind !== "retried") throw new Error("expected retry outcome");
		expect(outcome.attempt.status).toBe("QUEUED");
		expect(outcome.attempt.predecessorAttemptId).toBe(seed.failedAttemptId);

		const [feature] = await sql`
			SELECT state, row_version FROM features WHERE id = ${seed.featureId}
		`;
		expect(feature?.state).toBe("QUEUED");
		expect(feature?.row_version).toBe(2);

		const [counts] = await sql`
			SELECT
				(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${seed.featureId}) AS attempts,
				(SELECT count(*)::int FROM idempotency_records WHERE feature_id = ${seed.featureId}) AS idempotency,
				(SELECT count(*)::int FROM activity_events WHERE feature_id = ${seed.featureId}) AS activity,
				(SELECT count(*)::int FROM audit_events WHERE feature_id = ${seed.featureId}) AS audit
		`;
		expect(counts).toMatchObject({ attempts: 2, idempotency: 1, activity: 1, audit: 1 });
	});

	test("returns one retry and one idempotent result for concurrent same-key requests", async () => {
		const seed = await seedRetryableFeature();
		const request = retryRequest(seed, `retry:${crypto.randomUUID()}`);
		const firstService = createRetryService({ sql: primaryClient.sql });
		const secondService = createRetryService({ sql: concurrentClient.sql });

		const outcomes = await Promise.all([firstService.retry(request), secondService.retry(request)]);

		expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["idempotent", "retried"]);
		const attemptIds = outcomes.flatMap((outcome) =>
			outcome.kind === "blocked" ? [] : [outcome.attempt.id],
		);
		expect(new Set(attemptIds).size).toBe(1);

		const [counts] = await sql`
			SELECT
				(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${seed.featureId}) AS attempts,
				(SELECT count(*)::int FROM idempotency_records WHERE operation_key = ${request.operationKey}) AS idempotency,
				(SELECT count(*)::int FROM activity_events WHERE feature_id = ${seed.featureId}) AS activity,
				(SELECT count(*)::int FROM audit_events WHERE feature_id = ${seed.featureId}) AS audit
		`;
		expect(counts).toMatchObject({ attempts: 2, idempotency: 1, activity: 1, audit: 1 });
	});

	test("rolls back the entire retry when audit persistence fails", async () => {
		const seed = await seedRetryableFeature();
		await sql.unsafe(`
			CREATE FUNCTION fail_retry_audit() RETURNS trigger AS $$
			BEGIN
				IF NEW.action = 'development.retry' THEN
					RAISE EXCEPTION 'forced retry audit failure';
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER fail_retry_audit_insert
				BEFORE INSERT ON audit_events
				FOR EACH ROW EXECUTE FUNCTION fail_retry_audit();
		`);

		try {
			await expect(createRetryService({ sql }).retry(retryRequest(seed))).rejects.toThrow(
				"forced retry audit failure",
			);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS fail_retry_audit_insert ON audit_events;
				DROP FUNCTION IF EXISTS fail_retry_audit();
			`);
		}

		const [state] = await sql`
			SELECT
				(SELECT state FROM features WHERE id = ${seed.featureId}) AS feature_state,
				(SELECT count(*)::int FROM development_job_attempts WHERE feature_id = ${seed.featureId}) AS attempts,
				(SELECT count(*)::int FROM idempotency_records WHERE feature_id = ${seed.featureId}) AS idempotency,
				(SELECT count(*)::int FROM activity_events WHERE feature_id = ${seed.featureId}) AS activity
		`;
		expect(state).toMatchObject({
			feature_state: "DEVELOPMENT_FAILED",
			attempts: 1,
			idempotency: 0,
			activity: 0,
		});
	});

	test("blocks retry when feature state is not retryable", async () => {
		const seed = await seedRetryableFeature();
		await sql`UPDATE features SET state = 'PLANNED' WHERE id = ${seed.featureId}`;
		const outcome = await createRetryService({ sql }).retry(retryRequest(seed));
		expect(outcome.kind).toBe("blocked");
	});

	test("blocks retry when approval is missing or invalidated", async () => {
		const seed = await seedRetryableFeature();
		const outcome = await createRetryService({ sql }).retry({
			...retryRequest(seed),
			taskApprovalId: crypto.randomUUID(),
		});
		expect(outcome.kind).toBe("blocked");
	});

	test("blocks retry when attempt status is not retryable", async () => {
		const seed = await seedRetryableFeature();
		await sql`UPDATE development_job_attempts SET status = 'QUEUED' WHERE id = ${seed.failedAttemptId}`;
		const outcome = await createRetryService({ sql }).retry(retryRequest(seed));
		expect(outcome.kind).toBe("blocked");
	});

	test("blocks retry on branch mismatch", async () => {
		const seed = await seedRetryableFeature();
		const outcome = await createRetryService({ sql }).retry({
			...retryRequest(seed),
			branchName: "feature/wrong-branch",
		});
		expect(outcome.kind).toBe("blocked");
	});

	test("blocks retry when project/feature do not match", async () => {
		const seed = await seedRetryableFeature();
		const outcome = await createRetryService({ sql }).retry({
			...retryRequest(seed),
			projectId: crypto.randomUUID(),
		});
		expect(outcome.kind).toBe("blocked");
	});

	test("returns idempotent retry for repeated operation key", async () => {
		const seed = await seedRetryableFeature();
		const request = retryRequest(seed, `retry:${crypto.randomUUID()}`);
		const service = createRetryService({ sql });
		const first = await service.retry(request);
		expect(first.kind).toBe("retried");
		const second = await service.retry(request);
		expect(second.kind).toBe("idempotent");
	});

	test("blocks retry when operation key belongs to another project/feature", async () => {
		const seedA = await seedRetryableFeature();
		const seedB = await seedRetryableFeature();
		const key = `retry:${crypto.randomUUID()}`;
		const service = createRetryService({ sql });
		const first = await service.retry(retryRequest(seedA, key));
		expect(first.kind).toBe("retried");
		const blocked = await service.retry(retryRequest(seedB, key));
		expect(blocked.kind).toBe("blocked");
	});

	test("blocks a repeated operation whose durable attempt reference is absent", async () => {
		const seed = await seedRetryableFeature();
		const operationKey = `retry:${crypto.randomUUID()}`;
		await createIdempotencyRecord(sql, {
			operationKey,
			projectId: seed.projectId,
			featureId: seed.featureId,
			result: { kind: "retried" },
		});

		const outcome = await createRetryService({ sql }).retry(retryRequest(seed, operationKey));
		expect(outcome).toEqual({ kind: "blocked", reason: "Prior retry attempt was not found." });
	});

	test("blocks when the feature or its prior attempt is absent", async () => {
		const missingFeature = await createRetryService({ sql }).retry({
			featureId: crypto.randomUUID(),
			projectId: crypto.randomUUID(),
			taskApprovalId: crypto.randomUUID(),
			branchName: "feature/missing",
			operationKey: `retry:${crypto.randomUUID()}`,
			reason: "missing",
			actorId: crypto.randomUUID(),
		});
		expect(missingFeature).toEqual({ kind: "blocked", reason: "Feature not found." });

		const seed = await seedRetryableFeature();
		await sql`DELETE FROM development_job_attempts WHERE id = ${seed.failedAttemptId}`;
		const missingAttempt = await createRetryService({ sql }).retry(retryRequest(seed));
		expect(missingAttempt).toEqual({ kind: "blocked", reason: "No existing attempt found." });
	});

	test("retries when a recorded process is confirmed gone and supplies the default summary", async () => {
		const seed = await seedRetryableFeature();
		await sql`
			UPDATE development_job_attempts
			SET process_pid = 9999, process_start_identity = '12345'
			WHERE id = ${seed.failedAttemptId}
		`;
		const request = { ...retryRequest(seed), reason: "" };
		const outcome = await createRetryService({
			sql,
			autopilot: {
				async isAlive() {
					return false;
				},
			} as never,
		}).retry(request);
		expect(outcome.kind).toBe("retried");
		const [activity] = await sql`
			SELECT summary FROM activity_events
			WHERE feature_id = ${seed.featureId} AND type = 'development.retried'
		`;
		expect(activity?.summary).toContain("explicit retry");
	});

	test("blocks when optimistic feature ownership changes during retry", async () => {
		const seed = await seedRetryableFeature();
		await sql.unsafe(`
			CREATE FUNCTION suppress_retry_feature_update() RETURNS trigger AS $$
			BEGIN
				IF NEW.state = 'QUEUED' AND OLD.state = 'DEVELOPMENT_FAILED' THEN
					RETURN NULL;
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER suppress_retry_feature_update
				BEFORE UPDATE ON features
				FOR EACH ROW EXECUTE FUNCTION suppress_retry_feature_update();
		`);
		try {
			const outcome = await createRetryService({ sql }).retry(retryRequest(seed));
			expect(outcome).toEqual({ kind: "blocked", reason: "Feature changed while retrying." });
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS suppress_retry_feature_update ON features;
				DROP FUNCTION IF EXISTS suppress_retry_feature_update();
			`);
		}
	});

	test("blocks retry when a process may still be active", async () => {
		const seed = await seedRetryableFeature();
		await sql`
			UPDATE development_job_attempts
			SET process_pid = 9999, process_start_identity = '12345'
			WHERE id = ${seed.failedAttemptId}
		`;
		const outcome = await createRetryService({
			sql,
			autopilot: {
				async isAlive() {
					return true;
				},
			} as never,
		}).retry(retryRequest(seed));
		expect(outcome.kind).toBe("blocked");
	});
});
