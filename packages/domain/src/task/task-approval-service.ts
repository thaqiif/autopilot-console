/**
 * Transactional task attachment, approval, and Approve & Queue Development (F-15).
 */

import { readFile } from "node:fs/promises";
import { parseTaskBytes, summarizeTaskFile, type TaskSummary } from "../../../autopilot/src/index";
import type { Queryable } from "../../../database/src/client";
import {
	appendActivityEvent,
	appendAuditEvent,
	createDevelopmentAttempt,
	createIdempotencyRecord,
	getFeatureById as getFeatureRow,
	getProjectById,
	createTaskApproval as insertTaskApproval,
} from "../../../database/src/index";
import { resolveTaskPath } from "../../../shared/src/fs/task-path";
import { redactValue } from "../../../shared/src/security/redaction";
import type { Feature } from "../feature/feature";
import { applyFeatureTransition } from "../feature/feature-state-machine";
import type { ProjectActor } from "../project/project";
import { isUniqueViolation, withTransaction } from "../shared/transaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskArtifactFailureReason =
	| "VALIDATION_FAILED"
	| "ILLEGAL_STATE"
	| "APPROVAL_ACTIVE"
	| "STALE_CHECKSUM"
	| "NOT_FOUND"
	| "FEATURE_NOT_FOUND";

export interface ApprovalResult {
	id: string;
	checksum: string;
	relativeTaskPath: string;
	approvedByAdminId: string;
	invalidatedAt: string | null;
	requirementsSnapshot: unknown;
}

export interface AttemptResult {
	id: string;
	status: string;
	taskApprovalId: string;
	branchName: string;
	operationKey: string;
	projectId: string;
	featureId: string;
}

export type AttachTaskResult =
	| {
			ok: true;
			feature: Feature;
			summary: TaskSummary;
			checksum: string;
	  }
	| {
			ok: false;
			reason: TaskArtifactFailureReason;
			message: string;
	  };

export type RemoveTaskResult =
	| { ok: true; feature: Feature }
	| { ok: false; reason: TaskArtifactFailureReason; message: string };

export type ApproveAndQueueResult =
	| {
			ok: true;
			feature: Feature;
			approval: ApprovalResult;
			attempt: AttemptResult;
			idempotent: boolean;
	  }
	| {
			ok: false;
			reason: TaskArtifactFailureReason;
			message: string;
	  };

export type InvalidateApprovalResult =
	| { ok: true; approval: { id: string; invalidatedAt: string } }
	| { ok: false; reason: TaskArtifactFailureReason; message: string };

export type ReplaceTaskResult =
	| {
			ok: true;
			feature: Feature;
			summary: TaskSummary;
			checksum: string;
			invalidatedApprovalId: string;
			idempotent: boolean;
	  }
	| { ok: false; reason: TaskArtifactFailureReason; message: string };

export interface TaskApprovalServiceOptions {
	sql: Queryable;
	now?: () => Date;
}

export interface TaskApprovalService {
	attachTask(input: {
		featureId: string;
		relativeTaskPath: string;
		actor: ProjectActor;
	}): Promise<AttachTaskResult>;

	removeTask(input: { featureId: string; actor: ProjectActor }): Promise<RemoveTaskResult>;

	approveAndQueue(input: {
		featureId: string;
		projectId?: string;
		displayedChecksum: string;
		operationKey: string;
		actor: ProjectActor;
	}): Promise<ApproveAndQueueResult>;

	invalidateApproval(input: {
		featureId: string;
		projectId?: string;
		approvalId: string;
		actor: ProjectActor;
	}): Promise<InvalidateApprovalResult>;

	replaceTask(input: {
		featureId: string;
		projectId: string;
		approvalId: string;
		relativeTaskPath: string;
		operationKey: string;
		actor: ProjectActor;
	}): Promise<ReplaceTaskResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FeatureRow {
	id: string;
	projectId: string;
	releaseId: string;
	slug: string;
	title: string;
	summary: string | null;
	state: string;
	branchName: string;
	taskPath: string | null;
	rowVersion: number;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

function mapFeature(row: FeatureRow): Feature {
	return {
		id: row.id,
		projectId: row.projectId,
		releaseId: row.releaseId,
		slug: row.slug,
		title: row.title,
		summary: row.summary,
		state: row.state as Feature["state"],
		branchName: row.branchName,
		taskPath: row.taskPath,
		rowVersion: row.rowVersion,
		archivedAt: row.archivedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

const REATTACH_STATES = new Set([
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
]);

const LEGAL_ATTACH_STATES = new Set(["PLANNED", "TASKS_REVIEW", ...REATTACH_STATES]);
const INVALIDATE_APPROVAL_STATES = new Set(["TASKS_REVIEW", ...REATTACH_STATES]);

/**
 * Validate a project-relative task path by resolving it against the project's
 * canonical root and checking it is a readable JSON file.
 */
async function readAndParseTaskFile(
	projectRoot: string,
	relativePath: string,
): Promise<
	| { ok: true; checksum: string; summary: TaskSummary; sourceBytes: Uint8Array }
	| { ok: false; reason: TaskArtifactFailureReason; message: string }
> {
	let resolvedTask: { absolute: string };
	try {
		resolvedTask = await resolveTaskPath(projectRoot, relativePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Task path validation failed";
		return { ok: false, reason: "VALIDATION_FAILED", message: msg };
	}

	let bytes: Buffer;
	try {
		bytes = await readFile(resolvedTask.absolute);
	} catch {
		return { ok: false, reason: "VALIDATION_FAILED", message: "Task file not readable" };
	}

	const parsed = parseTaskBytes(bytes);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: "VALIDATION_FAILED",
			message: parsed.errors.join("; "),
		};
	}

	const summary = summarizeTaskFile(parsed.document);
	return { ok: true, checksum: parsed.checksum, summary, sourceBytes: new Uint8Array(bytes) };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskApprovalService(
	options: TaskApprovalServiceOptions,
): TaskApprovalService {
	const { sql } = options;
	const now = options.now ?? (() => new Date());

	async function hasActiveApproval(featureId: string): Promise<boolean> {
		const rows = await sql`
			SELECT 1 FROM task_approvals
			WHERE feature_id = ${featureId}
				AND invalidated_at IS NULL
			LIMIT 1
		`;
		return rows.length > 0;
	}

	return {
		// ------------------------------------------------------------------
		// attachTask
		// ------------------------------------------------------------------
		async attachTask({ featureId, relativeTaskPath, actor }) {
			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}

			const project = await getProjectById(sql, featureRow.projectId);
			if (!project) {
				return { ok: false, reason: "NOT_FOUND", message: "Project not found" };
			}

			// State check
			if (!LEGAL_ATTACH_STATES.has(featureRow.state)) {
				return {
					ok: false,
					reason: "ILLEGAL_STATE",
					message: `Cannot attach task in state ${featureRow.state}`,
				};
			}

			if (REATTACH_STATES.has(featureRow.state)) {
				const active = await hasActiveApproval(featureId);
				if (active) {
					return {
						ok: false,
						reason: "APPROVAL_ACTIVE",
						message: "Prior approval must be invalidated before re-attaching a task",
					};
				}
			}

			// Validate and parse task file
			const parsed = await readAndParseTaskFile(project.canonicalPath, relativeTaskPath);
			if (!parsed.ok) return parsed;

			// Transaction: transition + update feature + activity + audit
			const feature = await withTransaction(sql, async (tx) => {
				const currentRow = await getFeatureRow(tx, featureId);
				if (!currentRow) throw new Error("Feature disappeared during transaction");
				const alreadyInReview = currentRow.state === "TASKS_REVIEW";
				const needsReset = REATTACH_STATES.has(currentRow.state);

				if (needsReset) {
					await tx`
						UPDATE features
						SET state = 'PLANNED',
							task_path = ${relativeTaskPath},
							row_version = row_version + 1,
							updated_at = now()
						WHERE id = ${featureId}
					`;
				}

				if (!alreadyInReview) {
					const prevState = needsReset ? "PLANNED" : (currentRow.state as Feature["state"]);
					const transition = applyFeatureTransition({
						featureId,
						from: prevState as Feature["state"],
						to: "TASKS_REVIEW" as Feature["state"],
						owner: "human_and_validation",
						cause: "task.attach",
						operationId: `attach:${featureId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
						expectedVersion: currentRow.rowVersion,
						currentVersion: currentRow.rowVersion,
					});

					if (transition.kind === "rejected") {
						throw new Error(`State transition rejected: ${transition.message}`);
					}

					await tx`
						UPDATE features
						SET state = 'TASKS_REVIEW',
							task_path = ${relativeTaskPath},
							row_version = row_version + 1,
							updated_at = now()
						WHERE id = ${featureId}
					`;
				} else {
					await tx`
						UPDATE features
						SET task_path = ${relativeTaskPath},
							row_version = row_version + 1,
							updated_at = now()
						WHERE id = ${featureId}
					`;
				}

				await appendActivityEvent(tx, {
					projectId: featureRow.projectId,
					featureId,
					type: "feature.task_attached",
					summary: `Task ${relativeTaskPath} attached to feature`,
					source: "domain:task-approval-service",
					metadata: { checksum: parsed.checksum, taskPath: relativeTaskPath },
				});

				await appendAuditEvent(tx, {
					actorType: actor.actorType,
					actorId: actor.actorId,
					action: "feature.task.attach",
					targetType: "feature",
					targetId: featureId,
					projectId: featureRow.projectId,
					featureId,
					correlationId: actor.correlationId,
					result: "success",
					nextValues: redactValue({ taskPath: relativeTaskPath, checksum: parsed.checksum }),
				});

				const updated = await getFeatureRow(tx, featureId);
				if (!updated) throw new Error("Feature disappeared during transaction");
				return mapFeature(updated);
			});

			return {
				ok: true,
				feature,
				summary: parsed.summary,
				checksum: parsed.checksum,
			};
		},

		// ------------------------------------------------------------------
		// removeTask
		// ------------------------------------------------------------------
		async removeTask({ featureId, actor }) {
			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}

			if (featureRow.state !== "TASKS_REVIEW") {
				return {
					ok: false,
					reason: "ILLEGAL_STATE",
					message: `Cannot remove task in state ${featureRow.state}`,
				};
			}

			const feature = await withTransaction(sql, async (tx) => {
				const currentRow = await getFeatureRow(tx, featureId);
				if (!currentRow) throw new Error("Feature disappeared during transaction");

				const transition = applyFeatureTransition({
					featureId,
					from: "TASKS_REVIEW" as Feature["state"],
					to: "PLANNED" as Feature["state"],
					owner: "human",
					cause: "task.remove",
					operationId: `remove:${featureId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
					expectedVersion: currentRow.rowVersion,
					currentVersion: currentRow.rowVersion,
				});

				if (transition.kind === "rejected") {
					throw new Error(`State transition rejected: ${transition.message}`);
				}

				await tx`
					UPDATE features
					SET state = 'PLANNED',
						task_path = NULL,
						row_version = row_version + 1,
						updated_at = now()
					WHERE id = ${featureId}
				`;

				await appendActivityEvent(tx, {
					projectId: featureRow.projectId,
					featureId,
					type: "feature.task_removed",
					summary: "Task removed from feature",
					source: "domain:task-approval-service",
				});

				await appendAuditEvent(tx, {
					actorType: actor.actorType,
					actorId: actor.actorId,
					action: "feature.task.remove",
					targetType: "feature",
					targetId: featureId,
					projectId: featureRow.projectId,
					featureId,
					correlationId: actor.correlationId,
					result: "success",
				});

				const updated = await getFeatureRow(tx, featureId);
				if (!updated) throw new Error("Feature disappeared during transaction");
				return mapFeature(updated);
			});

			return { ok: true, feature };
		},

		// ------------------------------------------------------------------
		// approveAndQueue
		// ------------------------------------------------------------------
		async approveAndQueue({ featureId, projectId, displayedChecksum, operationKey, actor }) {
			// Fast path: same operation key already durable — return without racing the feature.
			const existingIdemp = await sql`
				SELECT result FROM idempotency_records
				WHERE operation_key = ${operationKey}
			`;
			if (existingIdemp.length > 0) {
				const cached = existingIdemp[0]?.result as Record<string, unknown> | null;
				const currentFeature = await getFeatureRow(sql, featureId);
				if (!currentFeature) {
					return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
				}
				if (projectId !== undefined && currentFeature.projectId !== projectId) {
					return { ok: false, reason: "NOT_FOUND", message: "Feature not found in project" };
				}
				if (cached) {
					return {
						ok: true,
						feature: mapFeature(currentFeature),
						approval: cached.approval as ApprovalResult,
						attempt: cached.attempt as AttemptResult,
						idempotent: true,
					};
				}
			}

			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}
			if (projectId !== undefined && featureRow.projectId !== projectId) {
				return { ok: false, reason: "NOT_FOUND", message: "Feature not found in project" };
			}

			// Reject illegal states before path/checksum validation so callers get a
			// stable ILLEGAL_STATE reason even when no task is attached yet.
			if (featureRow.state !== "TASKS_REVIEW") {
				return {
					ok: false,
					reason: "ILLEGAL_STATE",
					message: `Cannot approve in state ${featureRow.state}`,
				};
			}

			if (!featureRow.taskPath) {
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					message: "No task attached to feature",
				};
			}

			const project = await getProjectById(sql, featureRow.projectId);
			if (!project) {
				return { ok: false, reason: "NOT_FOUND", message: "Project not found" };
			}

			// Compute current checksum from source file outside the transaction.
			const parsed = await readAndParseTaskFile(project.canonicalPath, featureRow.taskPath);
			if (!parsed.ok) return parsed;

			if (displayedChecksum !== parsed.checksum) {
				return {
					ok: false,
					reason: "STALE_CHECKSUM",
					message: "Displayed checksum is stale; refresh task review and try again",
				};
			}

			// Transactional create under a feature row lock so concurrent different
			// operation keys cannot each create an attempt for the same feature.
			try {
				const outcome = await withTransaction(sql, async (tx) => {
					// Serialize every concurrent approve against this feature.
					await tx`SELECT id FROM features WHERE id = ${featureId} FOR UPDATE`;

					// Same-key replay after lock (winner may have finished between checks).
					const lockedIdemp = await tx`
						SELECT result FROM idempotency_records
						WHERE operation_key = ${operationKey}
					`;
					if (lockedIdemp.length > 0) {
						const cached = lockedIdemp[0]?.result as Record<string, unknown> | null;
						const current = await getFeatureRow(tx, featureId);
						if (cached && current) {
							return {
								kind: "idempotent" as const,
								feature: current,
								approval: cached.approval as ApprovalResult,
								attempt: cached.attempt as AttemptResult,
							};
						}
					}

					const currentRow = await getFeatureRow(tx, featureId);
					if (!currentRow) {
						return {
							kind: "error" as const,
							reason: "FEATURE_NOT_FOUND" as const,
							message: "Feature not found",
						};
					}
					if (projectId !== undefined && currentRow.projectId !== projectId) {
						return {
							kind: "error" as const,
							reason: "NOT_FOUND" as const,
							message: "Feature not found in project",
						};
					}
					if (currentRow.state !== "TASKS_REVIEW") {
						return {
							kind: "error" as const,
							reason: "ILLEGAL_STATE" as const,
							message: `Cannot approve in state ${currentRow.state}`,
						};
					}
					if (!currentRow.taskPath) {
						return {
							kind: "error" as const,
							reason: "VALIDATION_FAILED" as const,
							message: "No task attached to feature",
						};
					}

					const transition = applyFeatureTransition({
						featureId,
						from: "TASKS_REVIEW" as Feature["state"],
						to: "QUEUED" as Feature["state"],
						owner: "human",
						cause: "approve_and_queue",
						operationId: operationKey,
						expectedVersion: currentRow.rowVersion,
						currentVersion: currentRow.rowVersion,
						observedState: currentRow.state as Feature["state"],
					});

					if (transition.kind === "rejected") {
						return {
							kind: "error" as const,
							reason: "ILLEGAL_STATE" as const,
							message: transition.message,
						};
					}
					if (transition.kind !== "applied") {
						return {
							kind: "error" as const,
							reason: "ILLEGAL_STATE" as const,
							message: "Approve transition was already applied",
						};
					}

					const updated = await tx`
						UPDATE features
						SET state = ${transition.nextState},
							row_version = ${transition.nextVersion},
							updated_at = now()
						WHERE id = ${featureId}
							AND state = ${transition.priorState}
							AND row_version = ${transition.priorVersion}
						RETURNING id
					`;
					if (updated.length !== 1) {
						return {
							kind: "error" as const,
							reason: "ILLEGAL_STATE" as const,
							message: "Feature changed while approving; refresh and try again",
						};
					}

					const approval = await insertTaskApproval(tx, {
						projectId: currentRow.projectId,
						featureId,
						relativeTaskPath: currentRow.taskPath as string,
						checksum: parsed.checksum,
						schemaCompatibilityVersion: "1.0.0",
						requirementsSnapshot: parsed.summary.requirements,
						approvedByAdminId: actor.actorId,
					});

					const attempt = await createDevelopmentAttempt(tx, {
						projectId: currentRow.projectId,
						featureId,
						taskApprovalId: approval.id,
						branchName: currentRow.branchName,
						operationKey,
						status: "QUEUED",
					});

					await appendActivityEvent(tx, {
						projectId: currentRow.projectId,
						featureId,
						attemptId: attempt.id,
						type: "feature.queued",
						summary: "Feature queued for development",
						source: "domain:task-approval-service",
					});

					await appendAuditEvent(tx, {
						actorType: actor.actorType,
						actorId: actor.actorId,
						action: "feature.approve_and_queue",
						targetType: "feature",
						targetId: featureId,
						projectId: currentRow.projectId,
						featureId,
						attemptId: attempt.id,
						correlationId: actor.correlationId,
						result: "success",
						nextValues: redactValue({
							approvalId: approval.id,
							checksum: parsed.checksum,
							branchName: currentRow.branchName,
						}),
					});

					const idempotencyResult = {
						approval: {
							id: approval.id,
							checksum: approval.checksum,
							relativeTaskPath: approval.relativeTaskPath,
							approvedByAdminId: approval.approvedByAdminId,
							invalidatedAt: null as string | null,
							requirementsSnapshot: parsed.summary.requirements,
						} satisfies ApprovalResult,
						attempt: {
							id: attempt.id,
							status: attempt.status,
							taskApprovalId: attempt.taskApprovalId,
							branchName: attempt.branchName,
							operationKey: attempt.operationKey,
							projectId: attempt.projectId,
							featureId: attempt.featureId,
						} satisfies AttemptResult,
					};

					await createIdempotencyRecord(tx, {
						operationKey,
						projectId: currentRow.projectId,
						featureId,
						attemptId: attempt.id,
						result: idempotencyResult,
					});

					const queuedFeature = await getFeatureRow(tx, featureId);
					return {
						kind: "created" as const,
						feature: queuedFeature ?? currentRow,
						approval: idempotencyResult.approval,
						attempt: idempotencyResult.attempt,
					};
				});

				if (outcome.kind === "error") {
					return { ok: false, reason: outcome.reason, message: outcome.message };
				}

				return {
					ok: true,
					feature: mapFeature(outcome.feature),
					approval: outcome.approval,
					attempt: outcome.attempt,
					idempotent: outcome.kind === "idempotent",
				};
			} catch (err) {
				if (isUniqueViolation(err)) {
					const recheck = await sql`
						SELECT result FROM idempotency_records
						WHERE operation_key = ${operationKey}
					`;
					if (recheck.length > 0) {
						const cached = recheck[0]?.result as Record<string, unknown> | null;
						const currentFeature = await getFeatureRow(sql, featureId);
						if (cached && currentFeature) {
							return {
								ok: true,
								feature: mapFeature(currentFeature),
								approval: cached.approval as ApprovalResult,
								attempt: cached.attempt as AttemptResult,
								idempotent: true,
							};
						}
					}
					// Different operation key lost a uniqueness race — surface as illegal state.
					const currentFeature = await getFeatureRow(sql, featureId);
					return {
						ok: false,
						reason: "ILLEGAL_STATE",
						message: currentFeature
							? `Cannot approve in state ${currentFeature.state}`
							: "Feature changed while approving",
					};
				}
				throw err;
			}
		},

		// ------------------------------------------------------------------
		// invalidateApproval
		// ------------------------------------------------------------------
		async invalidateApproval({ featureId, projectId, approvalId, actor }) {
			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}
			if (projectId !== undefined && featureRow.projectId !== projectId) {
				return { ok: false, reason: "NOT_FOUND", message: "Feature not found in project" };
			}

			if (!INVALIDATE_APPROVAL_STATES.has(featureRow.state)) {
				return {
					ok: false,
					reason: "ILLEGAL_STATE",
					message: `Cannot invalidate approval in state ${featureRow.state}`,
				};
			}

			const invalidatedAt = now();
			const result = await withTransaction(sql, async (tx) => {
				const rows = await tx`
					UPDATE task_approvals
					SET invalidated_at = ${invalidatedAt}
					WHERE id = ${approvalId}
						AND feature_id = ${featureId}
						AND invalidated_at IS NULL
					RETURNING id, invalidated_at
				`;

				if (rows.length === 0) {
					throw new Error("Approval not found or already invalidated");
				}
				const row = rows[0];
				if (!row) throw new Error("Approval row missing");

				await appendAuditEvent(tx, {
					actorType: actor.actorType,
					actorId: actor.actorId,
					action: "feature.approval.invalidate",
					targetType: "task_approval",
					targetId: approvalId,
					projectId: featureRow.projectId,
					featureId,
					correlationId: actor.correlationId,
					result: "success",
					nextValues: redactValue({ invalidatedAt: invalidatedAt.toISOString() }),
				});

				return {
					id: row.id as string,
					invalidatedAt: (row.invalidated_at as Date).toISOString(),
				};
			});

			return { ok: true, approval: result };
		},

		async replaceTask({ featureId, projectId, approvalId, relativeTaskPath, operationKey, actor }) {
			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow || featureRow.projectId !== projectId) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}

			const cachedRows = await sql`
				SELECT result FROM idempotency_records WHERE operation_key = ${operationKey}
			`;
			const cached = cachedRows[0]?.result as
				| {
						kind?: string;
						approvalId?: string;
						checksum?: string;
						summary?: TaskSummary;
				  }
				| undefined;
			if (cachedRows.length > 0) {
				if (cached?.kind !== "task.replace" || cached.approvalId !== approvalId) {
					return {
						ok: false,
						reason: "VALIDATION_FAILED",
						message: "Operation key was already used for a different mutation",
					};
				}
				const current = await getFeatureRow(sql, featureId);
				if (!current || !cached.checksum || !cached.summary) {
					return { ok: false, reason: "NOT_FOUND", message: "Replacement result not found" };
				}
				return {
					ok: true,
					feature: mapFeature(current),
					summary: cached.summary,
					checksum: cached.checksum,
					invalidatedApprovalId: approvalId,
					idempotent: true,
				};
			}

			if (!REATTACH_STATES.has(featureRow.state)) {
				return {
					ok: false,
					reason: "ILLEGAL_STATE",
					message: `Cannot replace task in state ${featureRow.state}`,
				};
			}

			const project = await getProjectById(sql, projectId);
			if (!project) return { ok: false, reason: "NOT_FOUND", message: "Project not found" };
			const parsed = await readAndParseTaskFile(project.canonicalPath, relativeTaskPath);
			if (!parsed.ok) return parsed;

			try {
				const transactionResult = await withTransaction(sql, async (tx) => {
					await tx`SELECT id FROM features WHERE id = ${featureId} FOR UPDATE`;
					const invalidatedAt = now();
					const approvals = await tx`
						UPDATE task_approvals
						SET invalidated_at = ${invalidatedAt}
						WHERE id = ${approvalId}
							AND feature_id = ${featureId}
							AND project_id = ${projectId}
							AND invalidated_at IS NULL
						RETURNING id
					`;
					if (approvals.length === 0) {
						return {
							ok: false as const,
							reason: "NOT_FOUND" as const,
							message: "Active approval not found",
						};
					}

					await tx`
						UPDATE features
						SET state = 'TASKS_REVIEW', task_path = ${relativeTaskPath},
							row_version = row_version + 1, updated_at = now()
						WHERE id = ${featureId} AND project_id = ${projectId}
					`;
					await appendActivityEvent(tx, {
						projectId,
						featureId,
						type: "feature.task_replaced",
						summary: `Task replaced with ${relativeTaskPath}`,
						source: "domain:task-approval-service",
						metadata: { checksum: parsed.checksum, approvalId },
					});
					await appendAuditEvent(tx, {
						actorType: actor.actorType,
						actorId: actor.actorId,
						action: "feature.task.replace",
						targetType: "feature",
						targetId: featureId,
						projectId,
						featureId,
						correlationId: actor.correlationId,
						result: "success",
						nextValues: redactValue({ relativeTaskPath, checksum: parsed.checksum }),
					});
					const idempotencyResult = {
						kind: "task.replace",
						approvalId,
						checksum: parsed.checksum,
						summary: parsed.summary,
					};
					await createIdempotencyRecord(tx, {
						operationKey,
						projectId,
						featureId,
						result: idempotencyResult,
					});
					return { ok: true as const, idempotencyResult };
				});

				if (!transactionResult.ok) return transactionResult;
				const updated = await getFeatureRow(sql, featureId);
				if (!updated)
					return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
				return {
					ok: true,
					feature: mapFeature(updated),
					summary: parsed.summary,
					checksum: parsed.checksum,
					invalidatedApprovalId: approvalId,
					idempotent: false,
				};
			} catch (error) {
				if (isUniqueViolation(error)) {
					const [winner] = await sql`
						SELECT result FROM idempotency_records WHERE operation_key = ${operationKey}
					`;
					const result = winner?.result as { kind?: string; approvalId?: string } | undefined;
					if (result?.kind === "task.replace" && result.approvalId === approvalId) {
						return this.replaceTask({
							featureId,
							projectId,
							approvalId,
							relativeTaskPath,
							operationKey,
							actor,
						});
					}
				}
				throw error;
			}
		},
	};
}
