/**
 * PR action routes (requirement 22).
 *
 * POST /api/features/:id/pr-retry — retry PR creation
 *
 * Validates the attempt is in PR_CREATION_FAILED state and the feature
 * allows re-queuing. Delegates to domain for idempotent mutation.
 */

import { Hono } from "hono";
import type { Queryable, Sql, TransactionSql } from "../../../../packages/database/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	createIdempotencyRecord,
	createOutboxIntent,
} from "../../../../packages/database/src/index";
import { applyFeatureTransition, type FeatureState } from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrActionRoutesOptions {
	sql: Queryable;
}

export function createPrActionRoutes(options: PrActionRoutesOptions): Hono {
	const app = new Hono();
	const { sql } = options;

	app.post("/api/features/:id/pr-retry", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const featureId = c.req.param("id");

		if (!UUID_RE.test(featureId)) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId,
			});
		}

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Request body must be JSON.",
				httpStatus: 400,
				correlationId,
			});
		}

		const attemptId = typeof body.attemptId === "string" ? body.attemptId.trim() : "";
		const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";

		if (!attemptId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "attemptId is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (confirmation !== "retry-pr-creation") {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "confirmation must be 'retry-pr-creation'.",
				httpStatus: 400,
				correlationId,
			});
		}

		const operationKey = `pr-retry:${featureId}:${attemptId}`;
		const data = await withTransaction(sql, async (tx) => {
			const [feature] = await tx`
				SELECT id, project_id, state, row_version FROM features
				WHERE id = ${featureId} FOR UPDATE
			`;
			if (!feature) {
				throw createNormalizedError({
					code: "NOT_FOUND",
					message: "Feature not found.",
					httpStatus: 404,
					correlationId,
				});
			}

			const [prior] = await tx`
				SELECT result FROM idempotency_records WHERE operation_key = ${operationKey}
			`;
			if (prior) return prior.result as { featureId: string; attemptId: string; newState: string };

			if (feature.state !== "PR_CREATION_FAILED") {
				throw createNormalizedError({
					code: "PRECONDITION_FAILED",
					message: `Cannot retry PR creation in state ${feature.state}.`,
					httpStatus: 409,
					correlationId,
				});
			}

			const [attempt] = await tx`
				SELECT id, feature_id FROM development_job_attempts WHERE id = ${attemptId}
			`;
			if (!attempt || attempt.feature_id !== featureId) {
				throw createNormalizedError({
					code: "NOT_FOUND",
					message: "Development attempt not found for this feature.",
					httpStatus: 404,
					correlationId,
				});
			}

			const transition = applyFeatureTransition({
				featureId,
				from: feature.state as FeatureState,
				to: "PR_CREATING",
				owner: "human",
				cause: "pr_creation_retry",
				operationId: operationKey,
				expectedVersion: feature.row_version as number,
				currentVersion: feature.row_version as number,
			});
			if (transition.kind === "rejected") {
				throw createNormalizedError({
					code: "PRECONDITION_FAILED",
					message: transition.message,
					httpStatus: 409,
					correlationId,
				});
			}
			const applied = transition.kind === "idempotent" ? transition.result : transition;
			const updated = await tx`
				UPDATE features SET state = ${applied.nextState}, row_version = ${applied.nextVersion}, updated_at = now()
				WHERE id = ${featureId} AND state = ${applied.priorState} AND row_version = ${applied.priorVersion}
				RETURNING id
			`;
			if (updated.length !== 1) {
				throw createNormalizedError({
					code: "CONFLICT",
					message: "Feature changed while retrying PR creation.",
					httpStatus: 409,
					correlationId,
				});
			}

			const result = { featureId, attemptId, newState: applied.nextState };
			const projectId = feature.project_id as string;
			await createOutboxIntent(tx, {
				projectId,
				featureId,
				attemptId,
				kind: "create_pr",
				dedupeKey: operationKey,
				payload: { featureId, attemptId },
			});
			await appendActivityEvent(tx, {
				projectId,
				featureId,
				attemptId,
				type: "pr.creation_retried",
				summary: "Pull request creation retry queued.",
				source: "api",
			});
			await appendAuditEvent(tx, {
				actorType: "administrator",
				actorId: adminId,
				action: "pr.creation_retry",
				targetType: "feature",
				targetId: featureId,
				projectId,
				featureId,
				attemptId,
				correlationId,
				result: "queued",
				priorValues: { state: applied.priorState },
				nextValues: { state: applied.nextState },
			});
			await createIdempotencyRecord(tx, {
				operationKey,
				projectId,
				featureId,
				attemptId,
				result,
			});
			return result;
		});

		return c.json({ ok: true as const, data });
	});

	return app;
}

async function withTransaction<T>(
	sql: Queryable,
	operation: (tx: Queryable) => Promise<T>,
): Promise<T> {
	const capable = sql as Sql;
	if (typeof capable.begin === "function") {
		return capable.begin((tx: TransactionSql) => operation(tx)) as unknown as Promise<T>;
	}
	return operation(sql);
}
