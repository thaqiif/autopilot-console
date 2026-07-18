import type { AutopilotRunner } from "../../../../packages/autopilot/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	createDevelopmentAttempt,
	createIdempotencyRecord,
	type DevelopmentAttemptRow,
	type FeatureRow,
	type FeatureState,
	getDevelopmentAttempt,
	getFeatureById,
	type Queryable,
} from "../../../../packages/database/src/index";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type RetryOutcome =
	| { kind: "retried"; attempt: DevelopmentAttemptRow }
	| { kind: "blocked"; reason: string }
	| { kind: "idempotent"; attempt: DevelopmentAttemptRow };

export interface RetryRequest {
	featureId: string;
	projectId: string;
	taskApprovalId: string;
	branchName: string;
	operationKey: string;
	reason: string;
	actorId: string;
}

export interface RetryService {
	retry(request: RetryRequest): Promise<RetryOutcome>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RetryServiceOptions {
	sql: Queryable;
	autopilot?: AutopilotRunner;
	now?: () => Date;
}

const RETRYABLE_FEATURE_STATES: readonly FeatureState[] = [
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
];

const RETRYABLE_ATTEMPT_STATUSES = ["FAILED", "INTERRUPTED", "CANCELLED"] as const;

// ---------------------------------------------------------------------------
// Factory: createRetryService
// ---------------------------------------------------------------------------

export function createRetryService(options: RetryServiceOptions): RetryService {
	const { sql, autopilot } = options;
	const now = options.now ?? (() => new Date());

	return { retry };

	async function retry(request: RetryRequest): Promise<RetryOutcome> {
		// Idempotency check via idempotency_records table
		const idempotencyRows = await sql`
			SELECT attempt_id FROM idempotency_records WHERE operation_key = ${request.operationKey}
		`;
		if (idempotencyRows.length > 0) {
			const priorAttemptId = idempotencyRows[0]?.attempt_id as string | undefined;
			if (priorAttemptId) {
				const priorAttempt = await getDevelopmentAttempt(sql, priorAttemptId);
				if (priorAttempt) return { kind: "idempotent", attempt: priorAttempt };
			}
		}

		const feature = await getFeatureById(sql, request.featureId);
		if (!feature) return { kind: "blocked", reason: "Feature not found." };

		if (!RETRYABLE_FEATURE_STATES.includes(feature.state as FeatureState)) {
			return { kind: "blocked", reason: `Feature state ${feature.state} is not retryable.` };
		}

		// Find latest attempt for this feature
		const latestRows = await sql`
			SELECT id FROM development_job_attempts
			WHERE feature_id = ${request.featureId}
			ORDER BY enqueued_at DESC
			LIMIT 1
		`;
		const firstRow = latestRows[0];
		if (!firstRow) return { kind: "blocked", reason: "No existing attempt found." };
		const latest = await getDevelopmentAttempt(sql, firstRow.id as string);
		if (!latest) return { kind: "blocked", reason: "No existing attempt found." };

		if (!(RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(latest.status)) {
			return { kind: "blocked", reason: `Attempt status ${latest.status} is not retryable.` };
		}

		if (latest.branchName !== feature.branchName) {
			return { kind: "blocked", reason: "Branch mismatch between attempt and feature." };
		}

		// Liveness check: if process identity exists, verify no active process
		if (latest.processPid !== null && latest.processStartIdentity !== null) {
			if (autopilot) {
				const alive = await autopilot.isAlive({
					projectId: request.projectId,
					featureId: request.featureId,
					projectRoot: "",
					taskRelativePath: "",
					expectedBranch: feature.branchName ?? "",
					processIdentity: {
						pid: latest.processPid,
						startTimeMs: Number(latest.processStartIdentity),
					},
					startedAt: now().toISOString(),
				});
				if (alive) {
					return { kind: "blocked", reason: "Process may still be active; retry is unsafe." };
				}
			}
			// ponytail: add OS-level process liveness check via ProcessTreeInspector when integrated
		}

		const retryAttempt = await createDevelopmentAttempt(sql, {
			projectId: request.projectId,
			featureId: request.featureId,
			taskApprovalId: request.taskApprovalId,
			branchName: feature.branchName ?? request.branchName,
			operationKey: request.operationKey,
			status: "QUEUED",
			predecessorAttemptId: latest.id,
		});

		await createIdempotencyRecord(sql, {
			operationKey: request.operationKey,
			projectId: request.projectId,
			featureId: request.featureId,
			attemptId: retryAttempt.id,
			result: { kind: "retried", attemptId: retryAttempt.id },
		});

		await appendActivityEvent(sql, {
			projectId: request.projectId,
			featureId: request.featureId,
			attemptId: retryAttempt.id,
			type: "development.retried",
			summary: `Development retry queued: ${request.reason || "explicit retry"}`,
			source: "api",
		});

		await appendAuditEvent(sql, {
			actorType: "administrator",
			actorId: request.actorId,
			action: "development.retry",
			targetType: "development_attempt",
			targetId: retryAttempt.id,
			projectId: request.projectId,
			featureId: request.featureId,
			result: "success",
			priorValues: { predecessorAttemptId: latest.id, branchName: feature.branchName },
			nextValues: { attemptId: retryAttempt.id, status: "QUEUED" },
		});

		return { kind: "retried", attempt: retryAttempt };
	}
}
