import type { AutopilotRunner } from "../../../../packages/autopilot/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	createDevelopmentAttempt,
	createIdempotencyRecord,
	type DevelopmentAttemptRow,
	type FeatureState,
	getDevelopmentAttempt,
	getFeatureById,
	type Sql,
} from "../../../../packages/database/src/index";
import { applyFeatureTransition } from "../../../../packages/domain/src/index";

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
	sql: Sql;
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
		return sql.begin(async (tx) => {
			// Serialize a globally unique operation key before checking its durable result.
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${request.operationKey}, 0))`;
			const [idempotency] = await tx`
				SELECT project_id, feature_id, attempt_id
				FROM idempotency_records
				WHERE operation_key = ${request.operationKey}
			`;
			if (idempotency) {
				if (
					idempotency.project_id !== request.projectId ||
					idempotency.feature_id !== request.featureId
				) {
					return {
						kind: "blocked",
						reason: "Operation key is already associated with another retry.",
					};
				}
				const priorAttemptId = idempotency.attempt_id as string | null;
				const priorAttempt = priorAttemptId
					? await getDevelopmentAttempt(tx, priorAttemptId)
					: null;
				if (!priorAttempt) {
					return { kind: "blocked", reason: "Prior retry attempt was not found." };
				}
				return { kind: "idempotent", attempt: priorAttempt };
			}

			await tx`SELECT id FROM features WHERE id = ${request.featureId} FOR UPDATE`;
			const feature = await getFeatureById(tx, request.featureId);
			if (!feature) return { kind: "blocked", reason: "Feature not found." };
			if (feature.projectId !== request.projectId) {
				return { kind: "blocked", reason: "Feature does not belong to the requested project." };
			}

			if (!RETRYABLE_FEATURE_STATES.includes(feature.state as FeatureState)) {
				return { kind: "blocked", reason: `Feature state ${feature.state} is not retryable.` };
			}

			const [approval] = await tx`
				SELECT id FROM task_approvals
				WHERE id = ${request.taskApprovalId}
					AND project_id = ${request.projectId}
					AND feature_id = ${request.featureId}
					AND invalidated_at IS NULL
				FOR SHARE
			`;
			if (!approval) {
				return { kind: "blocked", reason: "An active task approval was not found." };
			}

			const [latestRow] = await tx`
				SELECT id FROM development_job_attempts
				WHERE feature_id = ${request.featureId}
				ORDER BY enqueued_at DESC, created_at DESC, id DESC
				LIMIT 1
				FOR UPDATE
			`;
			if (!latestRow) return { kind: "blocked", reason: "No existing attempt found." };
			const latest = await getDevelopmentAttempt(tx, latestRow.id as string);
			if (!latest) return { kind: "blocked", reason: "No existing attempt found." };

			if (!(RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(latest.status)) {
				return { kind: "blocked", reason: `Attempt status ${latest.status} is not retryable.` };
			}

			if (latest.branchName !== feature.branchName || request.branchName !== feature.branchName) {
				return { kind: "blocked", reason: "Branch mismatch between attempt and feature." };
			}

			if (latest.processPid !== null && latest.processStartIdentity !== null && autopilot) {
				const alive = await autopilot.isAlive({
					projectId: request.projectId,
					featureId: request.featureId,
					projectRoot: "",
					taskRelativePath: "",
					expectedBranch: feature.branchName,
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

			const transition = applyFeatureTransition(
				{
					featureId: feature.id,
					from: feature.state,
					to: "QUEUED",
					owner: "human",
					cause: "development_retry",
					operationId: request.operationKey,
					expectedVersion: feature.rowVersion,
					currentVersion: feature.rowVersion,
					observedState: feature.state,
				},
				{ now },
			);
			if (transition.kind !== "applied") {
				return {
					kind: "blocked",
					reason:
						transition.kind === "rejected"
							? transition.message
							: "Retry transition was already applied.",
				};
			}
			const updated = await tx`
				UPDATE features
				SET state = ${transition.nextState},
					row_version = ${transition.nextVersion},
					updated_at = now()
				WHERE id = ${feature.id}
					AND state = ${transition.priorState}
					AND row_version = ${transition.priorVersion}
				RETURNING id
			`;
			if (!updated[0]) return { kind: "blocked", reason: "Feature changed while retrying." };

			const retryAttempt = await createDevelopmentAttempt(tx, {
				projectId: request.projectId,
				featureId: request.featureId,
				taskApprovalId: request.taskApprovalId,
				branchName: feature.branchName,
				operationKey: request.operationKey,
				status: "QUEUED",
				predecessorAttemptId: latest.id,
			});

			await createIdempotencyRecord(tx, {
				operationKey: request.operationKey,
				projectId: request.projectId,
				featureId: request.featureId,
				attemptId: retryAttempt.id,
				result: { kind: "retried", attemptId: retryAttempt.id },
			});

			await appendActivityEvent(tx, {
				projectId: request.projectId,
				featureId: request.featureId,
				attemptId: retryAttempt.id,
				type: "development.retried",
				summary: `Development retry queued: ${request.reason || "explicit retry"}`,
				source: "api",
			});

			await appendAuditEvent(tx, {
				actorType: "administrator",
				actorId: request.actorId,
				action: "development.retry",
				targetType: "development_attempt",
				targetId: retryAttempt.id,
				projectId: request.projectId,
				featureId: request.featureId,
				attemptId: retryAttempt.id,
				result: "success",
				priorValues: {
					state: transition.priorState,
					predecessorAttemptId: latest.id,
					branchName: feature.branchName,
				},
				nextValues: {
					state: transition.nextState,
					attemptId: retryAttempt.id,
					status: "QUEUED",
				},
			});

			return { kind: "retried", attempt: retryAttempt };
		});
	}
}
