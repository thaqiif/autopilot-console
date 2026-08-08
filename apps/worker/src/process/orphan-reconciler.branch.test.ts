import { describe, expect, test } from "bun:test";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	Queryable,
} from "../../../../packages/database/src";
import { createOrphanReconciler } from "./orphan-reconciler";

function attempt(status: DevelopmentAttemptRow["status"]): DevelopmentAttemptRow {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		projectId: "00000000-0000-4000-8000-000000000002",
		featureId: "00000000-0000-4000-8000-000000000003",
		taskApprovalId: "00000000-0000-4000-8000-000000000004",
		branchName: "feature/test",
		operationKey: "develop:test",
		status,
		predecessorAttemptId: null,
		workerRegistrationId: null,
		processPid: null,
		processStartIdentity: null,
		leaseExpiresAt: null,
		heartbeatAt: null,
		enqueuedAt: new Date(0),
		startedAt: null,
		endedAt: null,
		exitCode: null,
		cancellationRequestedAt: null,
		cancellationReason: null,
		structuredResult: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

function feature(state: FeatureRow["state"]): FeatureRow {
	return {
		id: "00000000-0000-4000-8000-000000000003",
		projectId: "00000000-0000-4000-8000-000000000002",
		releaseId: "00000000-0000-4000-8000-000000000005",
		slug: "test",
		title: "Test",
		summary: null,
		state,
		branchName: "feature/test",
		taskPath: "tasks/test.json",
		rowVersion: 1,
		archivedAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

describe("orphan reconciler defensive branches", () => {
	test("ignores attempts that are no longer active", async () => {
		let queries = 0;
		const sql = (async () => {
			queries++;
			return [];
		}) as unknown as Queryable;
		await createOrphanReconciler({ sql }).reconcileOne(
			attempt("INTERRUPTED"),
			feature("DEVELOPMENT_INTERRUPTED"),
		);
		expect(queries).toBe(0);
	});

	test("safely skips an invalid or already-applied feature transition", async () => {
		let queries = 0;
		const sql = (async () => {
			queries++;
			return [];
		}) as unknown as Queryable;
		await createOrphanReconciler({ sql }).reconcileOne(
			attempt("RUNNING"),
			feature("DEVELOPMENT_INTERRUPTED"),
		);
		expect(queries).toBe(0);
	});

	test("stops when optimistic feature ownership has changed", async () => {
		let queries = 0;
		const sql = (async () => {
			queries++;
			return [];
		}) as unknown as Queryable;
		await createOrphanReconciler({ sql }).reconcileOne(
			attempt("CANCEL_REQUESTED"),
			feature("DEVELOPING"),
		);
		expect(queries).toBe(1);
	});
});
