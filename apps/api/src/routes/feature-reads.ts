/**
 * Feature read routes (requirement 23).
 */

import { Hono } from "hono";
import type { Queryable } from "../../../../packages/database/src/client";
import { createNormalizedError } from "../../../../packages/shared/src/index";
import { queryFeatureDetail } from "../queries/feature-detail-query";

export interface FeatureReadRouteOptions {
	sql: Queryable;
}

export function createFeatureReadRoutes(options: FeatureReadRouteOptions): Hono {
	const app = new Hono();

	app.get("/api/features/:id", async (c) => {
		const { id } = c.req.param();

		const detail = await queryFeatureDetail(options.sql, id);

		if (!detail) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Feature not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		return c.json({ ok: true as const, data: detail });
	});

	app.get("/api/jobs/:id", async (c) => {
		const { id } = c.req.param();
		const [job] = await options.sql`
			SELECT feature_id
			FROM development_job_attempts
			WHERE id = ${id}
		`;
		if (!job) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Development job not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		const detail = await queryFeatureDetail(options.sql, job.feature_id as string);
		const attempt = detail?.attempts.find((candidate) => candidate.id === id);
		if (!detail || !attempt) {
			throw createNormalizedError({
				code: "NOT_FOUND",
				message: "Development job not found.",
				httpStatus: 404,
				correlationId: c.get("correlationId") ?? "",
			});
		}

		return c.json({
			ok: true as const,
			data: {
				id: attempt.id,
				feature: {
					id: detail.id,
					projectId: detail.projectId,
					releaseId: detail.releaseId,
					title: detail.title,
					state: detail.state,
					branchName: detail.branchName,
				},
				attempt,
				taskApproval: detail.taskApproval,
				progress: detail.progress,
				attemptHistory: detail.attempts,
				failures: detail.failures.filter(
					(failure) => failure.attemptId === null || failure.attemptId === id,
				),
				diagnosticLogs: detail.diagnosticLogs.filter((log) => log.attemptId === id),
				pullRequest: detail.pullRequest,
				recentActivity: detail.recentActivity,
			},
		});
	});

	return app;
}
