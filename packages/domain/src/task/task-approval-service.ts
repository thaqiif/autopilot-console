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
		displayedChecksum: string;
		operationKey: string;
		actor: ProjectActor;
	}): Promise<ApproveAndQueueResult>;

	invalidateApproval(input: {
		featureId: string;
		approvalId: string;
		actor: ProjectActor;
	}): Promise<InvalidateApprovalResult>;
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
		async approveAndQueue({ featureId, displayedChecksum, operationKey, actor }) {
			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}

			// Idempotency check — before state validation so repeat calls succeed
			const existingIdemp = await sql`
				SELECT result FROM idempotency_records
				WHERE operation_key = ${operationKey}
			`;
			if (existingIdemp.length > 0) {
				const cached = existingIdemp[0]?.result as Record<string, unknown> | null;
				if (cached) {
					const currentFeature = (await getFeatureRow(sql, featureId)) ?? featureRow;
					return {
						ok: true,
						feature: mapFeature(currentFeature),
						approval: cached.approval as ApprovalResult,
						attempt: cached.attempt as AttemptResult,
						idempotent: true,
					};
				}
			}

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

			// Compute current checksum from source file
			const parsed = await readAndParseTaskFile(project.canonicalPath, featureRow.taskPath);
			if (!parsed.ok) return parsed;

			if (displayedChecksum !== parsed.checksum) {
				return {
					ok: false,
					reason: "STALE_CHECKSUM",
					message: "Displayed checksum is stale; refresh task review and try again",
				};
			}

			// Transactional create: approval + transition + attempt + events + idempotency
			try {
				const result = await withTransaction(sql, async (tx) => {
					const currentRow = await getFeatureRow(tx, featureId);
					if (!currentRow) throw new Error("Feature disappeared during transaction");

					const transition = applyFeatureTransition({
						featureId,
						from: "TASKS_REVIEW" as Feature["state"],
						to: "QUEUED" as Feature["state"],
						owner: "human",
						cause: "approve_and_queue",
						operationId: operationKey,
						expectedVersion: currentRow.rowVersion,
						currentVersion: currentRow.rowVersion,
					});

					if (transition.kind === "rejected") {
						throw new Error(`State transition rejected: ${transition.message}`);
					}

					await tx`
						UPDATE features
						SET state = 'QUEUED',
							row_version = row_version + 1,
							updated_at = now()
						WHERE id = ${featureId}
					`;

					const approval = await insertTaskApproval(tx, {
						projectId: featureRow.projectId,
						featureId,
						relativeTaskPath: featureRow.taskPath as string,
						checksum: parsed.checksum,
						schemaCompatibilityVersion: "1.0.0",
						requirementsSnapshot: parsed.summary.requirements,
						approvedByAdminId: actor.actorId,
					});

					const attempt = await createDevelopmentAttempt(tx, {
						projectId: featureRow.projectId,
						featureId,
						taskApprovalId: approval.id,
						branchName: featureRow.branchName,
						operationKey,
						status: "QUEUED",
					});

					await appendActivityEvent(tx, {
						projectId: featureRow.projectId,
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
						projectId: featureRow.projectId,
						featureId,
						attemptId: attempt.id,
						correlationId: actor.correlationId,
						result: "success",
						nextValues: redactValue({
							approvalId: approval.id,
							checksum: parsed.checksum,
							branchName: featureRow.branchName,
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
						projectId: featureRow.projectId,
						featureId,
						attemptId: attempt.id,
						result: idempotencyResult,
					});

					return idempotencyResult;
				});

				const updatedFeature = await getFeatureRow(sql, featureId);
				return {
					ok: true,
					feature: updatedFeature ? mapFeature(updatedFeature) : mapFeature(featureRow),
					approval: result.approval,
					attempt: result.attempt,
					idempotent: false,
				};
			} catch (err) {
				if (isUniqueViolation(err)) {
					const recheck = await sql`
						SELECT result FROM idempotency_records
						WHERE operation_key = ${operationKey}
					`;
					if (recheck.length > 0) {
						const cached = recheck[0]?.result as Record<string, unknown> | null;
						if (cached) {
							const currentFeature = await getFeatureRow(sql, featureId);
							return {
								ok: true,
								feature: currentFeature ? mapFeature(currentFeature) : mapFeature(featureRow),
								approval: cached.approval as ApprovalResult,
								attempt: cached.attempt as AttemptResult,
								idempotent: true,
							};
						}
					}
				}
				throw err;
			}
		},

		// ------------------------------------------------------------------
		// invalidateApproval
		// ------------------------------------------------------------------
		async invalidateApproval({ featureId, approvalId, actor }) {
			const featureRow = await getFeatureRow(sql, featureId);
			if (!featureRow) {
				return { ok: false, reason: "FEATURE_NOT_FOUND", message: "Feature not found" };
			}

			const allowedStates = new Set([
				"DEVELOPMENT_FAILED",
				"DEVELOPMENT_INTERRUPTED",
				"DEVELOPMENT_CANCELLED",
				"TASKS_REVIEW",
			]);

			if (!allowedStates.has(featureRow.state)) {
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
	};
}
