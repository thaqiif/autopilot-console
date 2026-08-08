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
	getDevelopmentAttempt,
	getFeatureById,
	type Sql,
	updateAttemptStatus,
} from "../../../../packages/database/src/index";
import { createCancellationController, type ProcessTreeInspector } from "./cancellation-controller";

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

function fakeTree(options?: {
	identityOk?: boolean;
	descendants?: number[];
}): ProcessTreeInspector {
	const signals: Array<{ pid: number; kind: string }> = [];
	return {
		async getDescendants() {
			return [...(options?.descendants ?? [])];
		},
		async verifyIdentity() {
			return options?.identityOk ?? true;
		},
		async signal(pid, kind) {
			signals.push({ pid, kind });
		},
	};
}

async function seedAttempt(status: "QUEUED" | "RUNNING") {
	const workspace = await createWorkspace(sql);
	const admin = await createAdminAccount(sql, {
		username: `admin-${crypto.randomUUID()}`,
		passwordHash: "hash",
	});
	const suffix = crypto.randomUUID();
	const project = await createProject(sql, {
		workspaceId: workspace.id,
		name: `Cancel Project ${suffix}`,
		slug: `cancel-${suffix}`,
		githubOwner: "acme",
		githubRepo: `cancel-${suffix}`,
		canonicalPath: `/workspaces/cancel-${suffix}`,
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
		state: status === "QUEUED" ? "QUEUED" : "DEVELOPING",
	});
	const approval = await createTaskApproval(sql, {
		projectId: project.id,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/login.json",
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
		operationKey: `develop:${suffix}`,
		status,
		processPid: status === "RUNNING" ? 4242 : undefined,
		processStartIdentity: status === "RUNNING" ? "1000" : undefined,
	});
	if (status === "RUNNING") {
		await updateAttemptStatus(sql, attempt.id, {
			status: "RUNNING",
			// keep pid identity from create when provided
		});
	}
	const refreshed = await getDevelopmentAttempt(sql, attempt.id);
	const featureRow = await getFeatureById(sql, feature.id);
	if (!refreshed || !featureRow) throw new Error("seed failed");
	return {
		attempt: refreshed,
		feature: featureRow,
		handle: {
			projectId: project.id,
			featureId: feature.id,
			projectRoot: project.canonicalPath,
			taskRelativePath: approval.relativeTaskPath,
			expectedBranch: branchName,
			processIdentity: { pid: 4242, startTimeMs: 1000 },
			startedAt: new Date().toISOString(),
		},
	};
}

beforeAll(async () => {
	adminClient = createDatabaseClient(ADMIN_DATABASE_URL);
	databaseName = `cancel_ctl_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
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
}, 30_000);

describe("production cancellation controller", () => {
	test("uses default options and blocks unsupported attempt states", async () => {
		const seed = await seedAttempt("QUEUED");
		const controller = createCancellationController({ sql, tree: fakeTree() });
		const queued = await controller.cancelQueued(
			{ ...seed.attempt, status: "FAILED" },
			seed.feature,
			"invalid state",
			`cancel-defaults:${seed.attempt.id}`,
		);
		expect(queued.kind).toBe("blocked");
		const running = await controller.cancelRunning(
			{ ...seed.attempt, status: "FAILED" },
			seed.feature,
			seed.handle,
			"invalid state",
			`cancel-running-defaults:${seed.attempt.id}`,
		);
		expect(running.kind).toBe("blocked");
	});

	test("cancels a queued attempt and is idempotent", async () => {
		const seed = await seedAttempt("QUEUED");
		const controller = createCancellationController({
			sql,
			tree: fakeTree(),
			sleep: async () => {},
		});
		const first = await controller.cancelQueued(
			seed.attempt,
			seed.feature,
			"user cancel",
			`cancel:${seed.attempt.id}`,
		);
		expect(first.kind).toBe("cancelled");
		const feature = await getFeatureById(sql, seed.feature.id);
		expect(feature?.state).toBe("DEVELOPMENT_CANCELLED");
		const second = await controller.cancelQueued(
			{ ...seed.attempt, status: "CANCELLED" },
			feature ?? seed.feature,
			"user cancel",
			`cancel:${seed.attempt.id}:2`,
		);
		expect(second.kind).toBe("idempotent");
	});

	test("rejects cancellation when the feature transition is invalid", async () => {
		const seed = await seedAttempt("QUEUED");
		await sql`UPDATE features SET state = 'PLANNED' WHERE id = ${seed.feature.id}`;
		const feature = await getFeatureById(sql, seed.feature.id);
		if (!feature) throw new Error("missing feature");
		await expect(
			createCancellationController({ sql, tree: fakeTree() }).cancelQueued(
				seed.attempt,
				feature,
				"invalid transition",
				`cancel-invalid:${seed.attempt.id}`,
			),
		).rejects.toThrow(/forbidden transition/i);
	});

	test("blocks non-queued cancelQueued and cancels running with escalation", async () => {
		const queuedSeed = await seedAttempt("QUEUED");
		const controller = createCancellationController({
			sql,
			tree: fakeTree({ identityOk: true, descendants: [5001] }),
			graceMs: 1,
			killGraceMs: 1,
			sleep: async () => {},
		});
		const blocked = await controller.cancelQueued(
			{ ...queuedSeed.attempt, status: "RUNNING" },
			queuedSeed.feature,
			"nope",
			`cancel-blocked:${queuedSeed.attempt.id}`,
		);
		expect(blocked.kind).toBe("blocked");

		const runningSeed = await seedAttempt("RUNNING");
		// ensure pid fields are set on attempt row
		await sql`
			UPDATE development_job_attempts
			SET status = 'RUNNING', process_pid = 4242, process_start_identity = '1000'
			WHERE id = ${runningSeed.attempt.id}
		`;
		const attempt = await getDevelopmentAttempt(sql, runningSeed.attempt.id);
		if (!attempt) throw new Error("missing attempt");
		const outcome = await controller.cancelRunning(
			attempt,
			runningSeed.feature,
			runningSeed.handle,
			"stop it",
			`cancel-running:${attempt.id}`,
		);
		expect(outcome.kind).toBe("cancelled");
		const feature = await getFeatureById(sql, runningSeed.feature.id);
		expect(feature?.state).toBe("DEVELOPMENT_CANCELLED");
	});

	test("blocks running cancel when identity mismatches or process identity missing", async () => {
		const seed = await seedAttempt("RUNNING");
		await sql`
			UPDATE development_job_attempts
			SET status = 'RUNNING', process_pid = 4242, process_start_identity = '1000'
			WHERE id = ${seed.attempt.id}
		`;
		const attempt = await getDevelopmentAttempt(sql, seed.attempt.id);
		if (!attempt) throw new Error("missing attempt");
		const badIdentity = createCancellationController({
			sql,
			tree: fakeTree({ identityOk: false }),
			sleep: async () => {},
		});
		const blocked = await badIdentity.cancelRunning(
			attempt,
			seed.feature,
			seed.handle,
			"reuse",
			`cancel-pid:${attempt.id}`,
		);
		expect(blocked.kind).toBe("blocked");

		const noPid = createCancellationController({
			sql,
			tree: fakeTree(),
			sleep: async () => {},
		});
		const noIdentity = await noPid.cancelRunning(
			{ ...attempt, processPid: null, processStartIdentity: null },
			seed.feature,
			seed.handle,
			"no pid",
			`cancel-nopid:${attempt.id}`,
		);
		expect(noIdentity.kind).toBe("blocked");

		const mismatchedHandle = await noPid.cancelRunning(
			attempt,
			seed.feature,
			{ ...seed.handle, projectId: crypto.randomUUID() },
			"mismatch",
			`cancel-mismatch:${attempt.id}`,
		);
		expect(mismatchedHandle.kind).toBe("blocked");
	});

	test("stops escalation when the process exits after SIGTERM", async () => {
		const seed = await seedAttempt("RUNNING");
		await sql`
			UPDATE development_job_attempts
			SET status = 'RUNNING', process_pid = 4242, process_start_identity = '1000'
			WHERE id = ${seed.attempt.id}
		`;
		const attempt = await getDevelopmentAttempt(sql, seed.attempt.id);
		if (!attempt) throw new Error("missing attempt");
		const signals: string[] = [];
		let identityChecks = 0;
		const tree: ProcessTreeInspector = {
			async getDescendants() {
				return [5001];
			},
			async verifyIdentity() {
				identityChecks++;
				return identityChecks < 3;
			},
			async signal(_pid, kind) {
				signals.push(kind);
			},
		};
		const outcome = await createCancellationController({
			sql,
			tree,
			graceMs: 1,
			killGraceMs: 1,
			sleep: async () => {},
		}).cancelRunning(
			attempt,
			seed.feature,
			seed.handle,
			"stop after term",
			`cancel-term:${attempt.id}`,
		);

		expect(outcome.kind).toBe("cancelled");
		expect(signals).toContain("graceful");
		expect(signals).toContain("term");
		expect(signals).not.toContain("kill");

		const refreshedFeature = await getFeatureById(sql, seed.feature.id);
		if (!refreshedFeature) throw new Error("missing refreshed feature");
		const repeated = await createCancellationController({
			sql,
			tree,
			sleep: async () => {},
		}).cancelRunning(
			{ ...attempt, status: "CANCELLED" },
			refreshedFeature,
			seed.handle,
			"repeat",
			`cancel-term-repeat:${attempt.id}`,
		);
		expect(repeated.kind).toBe("idempotent");
	});

	test("skips escalation when the process exits during the graceful window", async () => {
		const seed = await seedAttempt("RUNNING");
		await sql`
			UPDATE development_job_attempts
			SET status = 'RUNNING', process_pid = 4242, process_start_identity = '1000'
			WHERE id = ${seed.attempt.id}
		`;
		const attempt = await getDevelopmentAttempt(sql, seed.attempt.id);
		if (!attempt) throw new Error("missing attempt");
		const signals: string[] = [];
		let identityChecks = 0;
		const outcome = await createCancellationController({
			sql,
			tree: {
				async getDescendants() {
					return [];
				},
				async verifyIdentity() {
					identityChecks++;
					return identityChecks === 1;
				},
				async signal(_pid, kind) {
					signals.push(kind);
				},
			},
			graceMs: 1,
			sleep: async () => {},
		}).cancelRunning(
			attempt,
			seed.feature,
			seed.handle,
			"graceful exit",
			`cancel-graceful:${attempt.id}`,
		);
		expect(outcome.kind).toBe("cancelled");
		expect(signals).toEqual(["graceful"]);
	});
});
