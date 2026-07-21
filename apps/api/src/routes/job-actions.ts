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
import type { Queryable } from "../../../../packages/database/src/index";
import {
	type DevelopmentAttemptRow,
	type FeatureRow,
	getDevelopmentAttempt,
	getFeatureById,
} from "../../../../packages/database/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

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

	app.post("/api/features/:id/cancel", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const _adminId = c.get("adminId") ?? "";
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

		if (confirmation !== "cancel-development") {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "confirmation must be 'cancel-development'.",
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

		// Find latest attempt for this feature
		const attemptRows = await sql`
			SELECT id FROM development_job_attempts
			WHERE feature_id = ${featureId}
			ORDER BY enqueued_at DESC
			LIMIT 1
		`;
		if (attemptRows.length === 0) {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: "No development attempt found for this feature.",
				httpStatus: 409,
				correlationId,
			});
		}

		const attempt = await getDevelopmentAttempt(sql, attemptRows[0]?.id as string);
		if (!attempt) {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: "Development attempt not found.",
				httpStatus: 409,
				correlationId,
			});
		}

		const operationId = `cancel:${featureId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const outcome = await cancelHandler(attempt, feature, reason, operationId);

		if (outcome.kind === "blocked") {
			throw createNormalizedError({
				code: "PRECONDITION_FAILED",
				message: outcome.reason ?? "Cancellation blocked.",
				httpStatus: 409,
				correlationId,
			});
		}

		return c.json({
			ok: true as const,
			data: {
				attemptId: outcome.attemptId ?? attempt.id,
				outcome: outcome.kind,
			},
		});
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

		const feature = await getFeatureById(sql, featureId);
		if (!feature) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId,
			});
		}

		// Find the latest task approval for this feature
		const approvalRows = await sql`
			SELECT id FROM task_approvals
			WHERE feature_id = ${featureId} AND invalidated_at IS NULL
			ORDER BY created_at DESC
			LIMIT 1
		`;
		const taskApprovalId = approvalRows.length > 0 ? (approvalRows[0]?.id as string) : "";

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
