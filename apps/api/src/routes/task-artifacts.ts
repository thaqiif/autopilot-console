/**
 * Task artifact routes (requirement 22).
 *
 * POST   /api/features/:id/task         — attach task to feature
 * DELETE /api/features/:id/task         — remove task from feature
 * POST   /api/features/:id/approve-queue — approve & queue development
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/index";
import type { TaskApprovalService } from "../../../../packages/domain/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";
import { createMutationIdempotency } from "../mutations/idempotency";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function confirmedTarget(
	body: Record<string, unknown>,
	pathFeatureId: string,
	correlationId: string,
): { projectId: string; featureId: string } {
	const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
	const featureId = typeof body.featureId === "string" ? body.featureId.trim() : "";
	if (!UUID_RE.test(projectId) || featureId !== pathFeatureId) {
		throw createNormalizedError({
			code: "VALIDATION_FAILED",
			message: "Confirmed project and feature must match the requested target.",
			httpStatus: 400,
			correlationId,
		});
	}
	return { projectId, featureId };
}

function isSafeRelativeJsonPath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		path.endsWith(".json") &&
		!path.split("/").some((segment) => segment === ".." || segment.length === 0)
	);
}

export interface TaskArtifactRoutesOptions {
	taskApprovalService: TaskApprovalService;
	sql: Queryable;
}

export function createTaskArtifactRoutes(options: TaskArtifactRoutesOptions): Hono {
	const app = new Hono();
	const { taskApprovalService, sql } = options;
	const idempotency = createMutationIdempotency(sql);

	app.post("/api/features/:id/task", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
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

		const relativeTaskPath =
			typeof body.relativeTaskPath === "string" ? body.relativeTaskPath.trim() : "";

		if (!relativeTaskPath) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "relativeTaskPath is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		const result = await taskApprovalService.attachTask({
			featureId,
			relativeTaskPath,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});

		if (!result.ok) {
			const code =
				result.reason === "FEATURE_NOT_FOUND" || result.reason === "NOT_FOUND"
					? "NOT_FOUND"
					: result.reason === "ILLEGAL_STATE"
						? "PRECONDITION_FAILED"
						: result.reason === "APPROVAL_ACTIVE"
							? "CONFLICT"
							: "VALIDATION_FAILED";
			const httpStatus =
				result.reason === "FEATURE_NOT_FOUND" || result.reason === "NOT_FOUND"
					? 404
					: result.reason === "ILLEGAL_STATE" || result.reason === "APPROVAL_ACTIVE"
						? 409
						: 400;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json(
			{
				ok: true as const,
				data: {
					feature: result.feature,
					summary: result.summary,
					checksum: result.checksum,
				},
			},
			200,
		);
	});

	app.delete("/api/features/:id/task", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const featureId = c.req.param("id");

		if (!UUID_RE.test(featureId)) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId,
			});
		}

		const result = await taskApprovalService.removeTask({
			featureId,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});

		if (!result.ok) {
			const code =
				result.reason === "FEATURE_NOT_FOUND"
					? "NOT_FOUND"
					: result.reason === "ILLEGAL_STATE"
						? "PRECONDITION_FAILED"
						: "VALIDATION_FAILED";
			const httpStatus =
				result.reason === "FEATURE_NOT_FOUND" ? 404 : result.reason === "ILLEGAL_STATE" ? 409 : 400;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json({ ok: true as const, data: result.feature }, 200);
	});

	app.post("/api/features/:id/approvals/:approvalId/invalidate", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const featureId = c.req.param("id");
		const approvalId = c.req.param("approvalId");
		if (!UUID_RE.test(featureId) || !UUID_RE.test(approvalId)) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature or approval not found.",
				httpStatus: 404,
				correlationId,
			});
		}
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const target = confirmedTarget(body, featureId, correlationId);
		const operationKey = typeof body.operationKey === "string" ? body.operationKey.trim() : "";
		if (!operationKey || body.confirmation !== "invalidate-task-approval") {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "operationKey and invalidate-task-approval confirmation are required.",
				httpStatus: 400,
				correlationId,
			});
		}
		const mutation = await idempotency.execute({
			operationKey,
			namespace: "task.approval.invalidate",
			correlationId,
			run: async () => {
				const result = await taskApprovalService.invalidateApproval({
					featureId,
					projectId: target.projectId,
					approvalId,
					actor: {
						actorType: "administrator",
						actorId: adminId,
						actorDisplay: adminUsername,
						correlationId,
					},
				});
				if (!result.ok) {
					const notFound = result.reason === "FEATURE_NOT_FOUND" || result.reason === "NOT_FOUND";
					throw createNormalizedError({
						code: notFound ? "NOT_FOUND" : "PRECONDITION_FAILED",
						message: result.message,
						httpStatus: notFound ? 404 : 409,
						correlationId,
					});
				}
				return result.approval;
			},
			scope: () => ({ projectId: target.projectId, featureId }),
		});
		return c.json({ ok: true as const, data: mutation.data }, 200);
	});

	app.put("/api/features/:id/task", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
		const featureId = c.req.param("id");
		if (!UUID_RE.test(featureId)) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId,
			});
		}
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const target = confirmedTarget(body, featureId, correlationId);
		const approvalId = typeof body.approvalId === "string" ? body.approvalId.trim() : "";
		const relativeTaskPath =
			typeof body.relativeTaskPath === "string" ? body.relativeTaskPath.trim() : "";
		const operationKey = typeof body.operationKey === "string" ? body.operationKey.trim() : "";
		if (
			!UUID_RE.test(approvalId) ||
			!isSafeRelativeJsonPath(relativeTaskPath) ||
			!operationKey ||
			body.confirmation !== "replace-task"
		) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message:
					"A safe JSON task path, approval, operation key, and replace-task confirmation are required.",
				httpStatus: 400,
				correlationId,
			});
		}
		const result = await taskApprovalService.replaceTask({
			featureId,
			projectId: target.projectId,
			approvalId,
			relativeTaskPath,
			operationKey,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});
		if (!result.ok) {
			const notFound = result.reason === "FEATURE_NOT_FOUND" || result.reason === "NOT_FOUND";
			throw createNormalizedError({
				code: notFound
					? "NOT_FOUND"
					: result.reason === "ILLEGAL_STATE"
						? "PRECONDITION_FAILED"
						: "VALIDATION_FAILED",
				message: result.message,
				httpStatus: notFound ? 404 : result.reason === "ILLEGAL_STATE" ? 409 : 400,
				correlationId,
			});
		}
		return c.json({ ok: true as const, data: result }, 200);
	});

	app.post("/api/features/:id/approve-queue", async (c) => {
		const correlationId = c.get("correlationId") ?? "";
		const adminId = c.get("adminId") ?? "";
		const adminUsername = c.get("adminUsername") ?? "";
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

		const displayedChecksum =
			typeof body.displayedChecksum === "string" ? body.displayedChecksum.trim() : "";
		const operationKey = typeof body.operationKey === "string" ? body.operationKey.trim() : "";
		const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
		const target = confirmedTarget(body, featureId, correlationId);

		if (!displayedChecksum) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "displayedChecksum is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (!operationKey) {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "operationKey is required.",
				httpStatus: 400,
				correlationId,
			});
		}

		if (confirmation !== "approve-and-queue") {
			throw createNormalizedError({
				code: "VALIDATION_FAILED",
				message: "confirmation must be 'approve-and-queue'.",
				httpStatus: 400,
				correlationId,
			});
		}

		const result = await taskApprovalService.approveAndQueue({
			featureId,
			projectId: target.projectId,
			displayedChecksum,
			operationKey,
			actor: {
				actorType: "administrator",
				actorId: adminId,
				actorDisplay: adminUsername,
				correlationId,
			},
		});

		if (!result.ok) {
			const code =
				result.reason === "FEATURE_NOT_FOUND"
					? "NOT_FOUND"
					: result.reason === "ILLEGAL_STATE"
						? "PRECONDITION_FAILED"
						: result.reason === "STALE_CHECKSUM"
							? "CONFLICT"
							: "VALIDATION_FAILED";
			const httpStatus =
				result.reason === "FEATURE_NOT_FOUND"
					? 404
					: result.reason === "ILLEGAL_STATE" || result.reason === "STALE_CHECKSUM"
						? 409
						: 400;
			throw createNormalizedError({
				code,
				message: result.message,
				httpStatus,
				correlationId,
			});
		}

		return c.json(
			{
				ok: true as const,
				data: {
					feature: result.feature,
					approval: result.approval,
					attempt: result.attempt,
					idempotent: result.idempotent,
				},
			},
			200,
		);
	});

	return app;
}
