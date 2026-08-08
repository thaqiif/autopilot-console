import { describe, expect, test } from "bun:test";
import type { Queryable } from "../client";
import { createDevelopmentQueue } from "./development-queue";
import { createLeaseReconciler } from "./lease-reconciler";

function sequencedQueryable(
	responses: Array<Array<Record<string, unknown>> & { count?: number }>,
): Queryable {
	let index = 0;
	return (async () => responses[index++] ?? []) as unknown as Queryable;
}

describe("critical queue branches", () => {
	test("claims without a transaction-capable client and applies default options", async () => {
		const createdAt = new Date("2026-08-08T00:00:00.000Z");
		const sql = sequencedQueryable([
			[{ id: "worker-registration" }],
			[{}],
			[{ id: "attempt-1" }],
			[
				{
					id: "attempt-1",
					project_id: "project-1",
					feature_id: "feature-1",
					task_approval_id: "approval-1",
					branch_name: "feature/one",
					operation_key: "develop:one",
					status: "RUNNING",
					enqueued_at: createdAt,
					created_at: createdAt,
					updated_at: createdAt,
				},
			],
		]);

		const result = await createDevelopmentQueue(sql).claimNextAttempt("worker-1");
		expect(result?.attempt).toMatchObject({
			id: "attempt-1",
			predecessorAttemptId: null,
			workerRegistrationId: null,
			processPid: null,
			processStartIdentity: null,
			leaseExpiresAt: null,
			heartbeatAt: null,
			startedAt: null,
			endedAt: null,
			exitCode: null,
			cancellationRequestedAt: null,
			cancellationReason: null,
			structuredResult: null,
		});
	});

	test("uses the lease reconciler default clock", async () => {
		const result = Object.assign([], { count: 2 });
		const sql = sequencedQueryable([result]);
		expect(await createLeaseReconciler(sql).interruptExpiredLeases()).toBe(2);
	});
});
