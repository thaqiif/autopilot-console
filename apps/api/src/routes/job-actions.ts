/**
 * Job action routes (requirement 22).
 *
 * POST /api/features/:id/cancel — cancel development
 * POST /api/features/:id/retry  — retry development
 *
 * These routes delegate to the domain layer for idempotency and validation.
 * Actual cancellation process escalation happens in the worker via
 * CancellationController, not in the API request scope.
 */

import { Hono } from "hono";
import type { Queryable, Sql, TransactionSql } from "../../../../packages/database/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	type DevelopmentAttemptRow,
	type FeatureRow,
	getDevelopmentAttempt,
	getFeatureById,
} from "../../../../packages/database/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";
import { createMutationIdempotency } from "../mutations/idempotency";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobActionRoutesOptions {
	sql: Queryable;
	cancelHandler: (
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		reason: string,
		operationId: string,
	) => Promise<{ kind: string; attemptId?: string; reason?: string }>;
	retryHandler: (request: {
		featureId: string;
		projectId: string;
		taskApprovalId: string;
		branchName: string;
		operationKey: string;
		reason: string;
		actorId: string;
	}) => Promise<{ kind: string; attempt?: DevelopmentAttemptRow; reason?: string }>;
}

export function createJobActionRoutes(options: JobActionRoutesOptions): Hono {
	const app = new Hono();
	const { sql, cancelHandler, retryHandler } = options;
	const idempotency = createMutationIdempotency(sql);

	app.post("/api/features/:id/cancel", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
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
		const reason = typeof body.reason === "string" ? body.reason.trim() : "user requested";
		const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
		const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
		const confirmedFeatureId = typeof body.featureId === "string" ? body.featureId.trim() : "";
		const operationKey = typeof body.operationKey === "string" ? body.operationKey.trim() : "";

		if (
			confirmation !== "cancel-development" ||
			!operationKey ||
			!UUID_RE.test(projectId) ||
			confirmedFeatureId !== featureId
		) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Stable operation key and exact project/feature confirmation are required.",
				httpStatus: 400,
				correlationId,
			});
		}

		const feature = await getFeatureById(sql, featureId);
		if (!feature) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId,
			});
		}
		if (feature.projectId !== projectId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Confirmed project does not own this feature.",
				httpStatus: 400,
				correlationId,
			});
		}

		const [latestAttempt] = await sql`
			SELECT id FROM development_job_attempts
			WHERE feature_id = ${featureId}
			ORDER BY enqueued_at DESC
			LIMIT 1
		`;
		if (!latestAttempt) {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: "No development attempt found for this feature.",
				httpStatus: 409,
				correlationId,
			});
		}

		const attempt = await getDevelopmentAttempt(sql, latestAttempt.id as string);
		if (!attempt) {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: "Development attempt not found.",
				httpStatus: 409,
				correlationId,
			});
		}

		const mutation = await idempotency.execute({
			operationKey,
			namespace: "development.cancel",
			correlationId,
			run: async () => {
				if (attempt.status === "RUNNING" || attempt.status === "CANCEL_REQUESTED") {
					return withTransaction(sql, async (tx) => {
						const [locked] = await tx`
							SELECT status
							FROM development_job_attempts
							WHERE id = ${attempt.id} AND project_id = ${projectId} AND feature_id = ${featureId}
							FOR UPDATE
						`;
						if (!locked) {
							throw createNormalizedError({
								code: "NOT_FOUND",
								message: "Development attempt not found for confirmed target.",
								httpStatus: 404,
								correlationId,
							});
						}
						if (locked.status === "RUNNING") {
							await tx`
								UPDATE development_job_attempts
								SET status = 'CANCEL_REQUESTED', cancellation_requested_at = now(),
									cancellation_reason = ${reason}, updated_at = now()
								WHERE id = ${attempt.id} AND status = 'RUNNING'
							`;
							await appendActivityEvent(tx, {
								projectId,
								featureId,
								attemptId: attempt.id,
								type: "development.cancel_requested",
								summary: "Development cancellation requested.",
								source: "api",
							});
							await appendAuditEvent(tx, {
								actorType: "administrator",
								actorId: c.get("adminId") ?? "",
								action: "development.cancel_request",
								targetType: "development_attempt",
								targetId: attempt.id,
								projectId,
								featureId,
								attemptId: attempt.id,
								correlationId,
								result: "requested",
								nextValues: { status: "CANCEL_REQUESTED" },
							});
						}
						return { attemptId: attempt.id, outcome: "cancel_requested" };
					});
				}

				const outcome = await cancelHandler(attempt, feature, reason, operationKey);
				if (outcome.kind === "blocked") {
					throw createNormalizedError({
						code: "PRECONDITION_FAILED",
						message: outcome.reason ?? "Cancellation blocked.",
						httpStatus: 409,
						correlationId,
					});
				}
				return { attemptId: outcome.attemptId ?? attempt.id, outcome: outcome.kind };
			},
			scope: (data) => ({ projectId, featureId, attemptId: data.attemptId }),
		});

		return c.json({ ok: true as const, data: mutation.data });
	});

	app.post("/api/features/:id/retry", async (c) => {
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
		const operationKey = typeof body.operationKey === "string" ? body.operationKey.trim() : "";
		const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
		const reason = typeof body.reason === "string" ? body.reason.trim() : "explicit retry";
		const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
		const confirmedFeatureId = typeof body.featureId === "string" ? body.featureId.trim() : "";

		if (!operationKey) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "operationKey is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (confirmation !== "retry-development") {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "confirmation must be 'retry-development'.",
				httpStatus: 400,
				correlationId,
			});
		}
		if (!UUID_RE.test(projectId) || confirmedFeatureId !== featureId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Confirmed project and feature must match the retry target.",
				httpStatus: 400,
				correlationId,
			});
		}

		const feature = await getFeatureById(sql, featureId);
		if (!feature) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId,
			});
		}
		if (feature.projectId !== projectId) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "Confirmed project does not own this feature.",
				httpStatus: 400,
				correlationId,
			});
		}

		const [latestApproval] = await sql`
			SELECT id FROM task_approvals
			WHERE feature_id = ${featureId} AND invalidated_at IS NULL
			ORDER BY created_at DESC
			LIMIT 1
		`;
		const taskApprovalId = (latestApproval?.id as string | undefined) ?? "";

		const outcome = await retryHandler({
			featureId,
			projectId: feature.projectId,
			taskApprovalId,
			branchName: feature.branchName ?? "",
			operationKey,
			reason,
			actorId: adminId,
		});

		if (outcome.kind === "blocked") {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: outcome.reason ?? "Retry blocked.",
				httpStatus: 409,
				correlationId,
			});
		}

		return c.json({
			ok: true as const,
			data: {
				attemptId: outcome.attempt?.id,
				outcome: outcome.kind,
			},
		});
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
