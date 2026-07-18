import type {
	AutopilotRunHandle,
	NormalizedRunResult,
} from "../../../../packages/autopilot/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	appendFailureRecord,
	createOutboxIntent,
	type DevelopmentAttemptRow,
	type FeatureRow,
	getDevelopmentAttempt,
	getFeatureById,
	getProjectById,
	getTaskApprovalById,
	heartbeatWorker,
	type Queryable,
	renewLease,
	type TransactionSql,
	updateAttemptStatus,
} from "../../../../packages/database/src/index";
import {
	applyFeatureTransition,
	type FailureKind,
	mapFailure,
	type TransitionOwner,
} from "../../../../packages/domain/src/index";
import type { DevelopmentExecutionContext } from "./preflight-orchestrator";

type BeginCapable = Queryable & {
	begin?<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T>;
};

export interface DevelopmentFailureInput {
	attemptId: string;
	workerRegistrationId: string;
	workerId: string;
	failureKind: Extract<FailureKind, "validation" | "git" | "process" | "task_result">;
	detail: string;
	targetState: "BLOCKED" | "DEVELOPMENT_FAILED";
	transitionOwner: Extract<TransitionOwner, "guard" | "worker">;
	structuredResult?: NormalizedRunResult;
	now: Date;
}

export interface DevelopmentWorkerStore {
	getAttempt(attemptId: string): Promise<DevelopmentAttemptRow | null>;
	loadContext(claimedAttempt: DevelopmentAttemptRow): Promise<DevelopmentExecutionContext>;
	markDeveloping(
		context: DevelopmentExecutionContext,
		input: { workerRegistrationId: string; workerId: string; now: Date },
	): Promise<void>;
	persistProcessIdentity(
		attemptId: string,
		input: {
			workerRegistrationId: string;
			handle: AutopilotRunHandle;
			heartbeatAt: Date;
			leaseExpiresAt: Date;
		},
	): Promise<void>;
	heartbeat(
		attemptId: string,
		input: { workerRegistrationId: string; leaseExpiresAt: Date },
	): Promise<void>;
	persistSuccess(
		attemptId: string,
		input: {
			workerRegistrationId: string;
			workerId: string;
			result: NormalizedRunResult;
			now: Date;
		},
	): Promise<void>;
	persistFailure(input: DevelopmentFailureInput): Promise<void>;
}

async function inTransaction<T>(sql: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
	const capable = sql as BeginCapable;
	if (typeof capable.begin === "function") return capable.begin((tx) => fn(tx));
	return fn(sql);
}

async function lockAttempt(sql: Queryable, attemptId: string): Promise<DevelopmentAttemptRow> {
	await sql`SELECT id FROM development_job_attempts WHERE id = ${attemptId} FOR UPDATE`;
	const attempt = await getDevelopmentAttempt(sql, attemptId);
	if (!attempt) throw new Error(`development attempt not found: ${attemptId}`);
	return attempt;
}

async function lockFeature(sql: Queryable, featureId: string): Promise<FeatureRow> {
	await sql`SELECT id FROM features WHERE id = ${featureId} FOR UPDATE`;
	const feature = await getFeatureById(sql, featureId);
	if (!feature) throw new Error(`feature not found: ${featureId}`);
	return feature;
}

function assertOwnership(attempt: DevelopmentAttemptRow, workerRegistrationId: string): void {
	if (attempt.workerRegistrationId !== workerRegistrationId || attempt.status !== "RUNNING") {
		throw new Error(`attempt ownership lost: ${attempt.id}`);
	}
}

async function persistFeatureTransition(
	sql: Queryable,
	input: {
		feature: FeatureRow;
		to: FeatureRow["state"];
		owner: TransitionOwner;
		cause: string;
		operationId: string;
		now: Date;
	},
): Promise<void> {
	const transition = applyFeatureTransition(
		{
			featureId: input.feature.id,
			from: input.feature.state,
			to: input.to,
			owner: input.owner,
			cause: input.cause,
			operationId: input.operationId,
			expectedVersion: input.feature.rowVersion,
			currentVersion: input.feature.rowVersion,
			observedState: input.feature.state,
		},
		{ now: () => input.now },
	);
	if (transition.kind !== "applied") {
		throw new Error(
			transition.kind === "rejected"
				? transition.message
				: `feature transition was already applied: ${input.operationId}`,
		);
	}
	const rows = await sql`
		UPDATE features
		SET state = ${transition.nextState},
			row_version = ${transition.nextVersion},
			updated_at = now()
		WHERE id = ${input.feature.id}
			AND state = ${transition.priorState}
			AND row_version = ${transition.priorVersion}
		RETURNING id
	`;
	if (!rows[0]) throw new Error(`feature transition conflict: ${input.feature.id}`);
}

export function createPostgresDevelopmentWorkerStore(sql: Queryable): DevelopmentWorkerStore {
	return {
		getAttempt: (attemptId) => getDevelopmentAttempt(sql, attemptId),
		async loadContext(claimedAttempt) {
			const attempt = await getDevelopmentAttempt(sql, claimedAttempt.id);
			if (!attempt) throw new Error("Claimed development attempt no longer exists.");
			const [project, feature, approval] = await Promise.all([
				getProjectById(sql, attempt.projectId),
				getFeatureById(sql, attempt.featureId),
				getTaskApprovalById(sql, attempt.taskApprovalId),
			]);
			if (!project || !feature || !approval) {
				throw new Error("Attempt references missing project, feature, or task approval data.");
			}
			return { attempt, project, feature, approval };
		},
		async markDeveloping(context, input) {
			await inTransaction(sql, async (tx) => {
				const attempt = await lockAttempt(tx, context.attempt.id);
				assertOwnership(attempt, input.workerRegistrationId);
				const feature = await lockFeature(tx, context.feature.id);
				await persistFeatureTransition(tx, {
					feature,
					to: "DEVELOPING",
					owner: "worker",
					cause: "development attempt claimed and preflight passed",
					operationId: `attempt:${attempt.id}:developing`,
					now: input.now,
				});
				await appendActivityEvent(tx, {
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					attemptId: attempt.id,
					type: "development.started",
					summary: "Development worker completed preflight and started the attempt.",
					source: "worker",
				});
				await appendAuditEvent(tx, {
					actorType: "worker",
					actorId: input.workerId,
					action: "development.start",
					targetType: "development_attempt",
					targetId: attempt.id,
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					attemptId: attempt.id,
					result: "success",
					priorValues: { featureState: feature.state, attemptStatus: attempt.status },
					nextValues: { featureState: "DEVELOPING", attemptStatus: attempt.status },
				});
			});
		},
		async persistProcessIdentity(attemptId, input) {
			await inTransaction(sql, async (tx) => {
				const attempt = await lockAttempt(tx, attemptId);
				assertOwnership(attempt, input.workerRegistrationId);
				if (attempt.processPid !== null || attempt.processStartIdentity !== null) {
					throw new Error(`attempt already has process identity: ${attempt.id}`);
				}
				const rows = await tx`
					UPDATE development_job_attempts
					SET process_pid = ${input.handle.processIdentity.pid},
						process_start_identity = ${String(input.handle.processIdentity.startTimeMs)},
						heartbeat_at = ${input.heartbeatAt},
						lease_expires_at = ${input.leaseExpiresAt},
						updated_at = now()
					WHERE id = ${attempt.id}
						AND worker_registration_id = ${input.workerRegistrationId}
						AND status = 'RUNNING'
					RETURNING id
				`;
				if (!rows[0]) throw new Error(`process identity persistence denied: ${attempt.id}`);
			});
		},
		async heartbeat(attemptId, input) {
			await Promise.all([
				heartbeatWorker(sql, input.workerRegistrationId, { activeJobs: 1 }),
				renewLease(sql, {
					attemptId,
					workerRegistrationId: input.workerRegistrationId,
					leaseExpiresAt: input.leaseExpiresAt,
				}),
			]);
		},
		async persistSuccess(attemptId, input) {
			await inTransaction(sql, async (tx) => {
				const attempt = await lockAttempt(tx, attemptId);
				assertOwnership(attempt, input.workerRegistrationId);
				const feature = await lockFeature(tx, attempt.featureId);
				await persistFeatureTransition(tx, {
					feature,
					to: "DEVELOPMENT_COMPLETE",
					owner: "agent_result_and_verification",
					cause: "Autopilot exited successfully and every structured requirement passed",
					operationId: `attempt:${attempt.id}:complete`,
					now: input.now,
				});
				await updateAttemptStatus(tx, attempt.id, {
					status: "SUCCEEDED",
					endedAt: input.now,
					exitCode: input.result.exitCode ?? 0,
					structuredResult: input.result,
				});
				await appendActivityEvent(tx, {
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					attemptId: attempt.id,
					type: "development.completed",
					summary: "Autopilot completed with every structured requirement passing.",
					source: "worker",
					metadata: { passed: input.result.progress.passed, total: input.result.progress.total },
				});
				await appendAuditEvent(tx, {
					actorType: "worker",
					actorId: input.workerId,
					action: "development.complete",
					targetType: "development_attempt",
					targetId: attempt.id,
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					attemptId: attempt.id,
					result: "success",
					priorValues: { featureState: feature.state, attemptStatus: attempt.status },
					nextValues: { featureState: "DEVELOPMENT_COMPLETE", attemptStatus: "SUCCEEDED" },
				});
				await createOutboxIntent(tx, {
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					attemptId: attempt.id,
					kind: "create_pr",
					dedupeKey: `create_pr:${attempt.featureId}`,
					payload: { branchName: attempt.branchName },
				});
			});
		},
		async persistFailure(input) {
			const projection = mapFailure({ kind: input.failureKind, detail: input.detail });
			const isBlocked = input.targetState === "BLOCKED";
			await inTransaction(sql, async (tx) => {
				const attempt = await lockAttempt(tx, input.attemptId);
				assertOwnership(attempt, input.workerRegistrationId);
				const feature = await lockFeature(tx, attempt.featureId);
				const ctx = {
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					attemptId: attempt.id,
				};
				await persistFeatureTransition(tx, {
					feature,
					to: input.targetState,
					owner: input.transitionOwner,
					cause: projection.summary,
					operationId: `attempt:${attempt.id}:failure:${input.targetState}`,
					now: input.now,
				});
				await updateAttemptStatus(tx, attempt.id, {
					status: "FAILED",
					endedAt: input.now,
					exitCode: input.structuredResult?.exitCode ?? undefined,
					structuredResult: input.structuredResult ?? { outcome: "failed", failure: projection },
				});
				await appendFailureRecord(tx, {
					...ctx,
					category: projection.kind,
					summary: projection.summary,
					recommendedAction: projection.recommendedAction,
					details: projection.detail ? { detail: projection.detail } : {},
				});
				await appendActivityEvent(tx, {
					...ctx,
					type: isBlocked ? "development.blocked" : "development.failed",
					summary: projection.summary,
					source: "worker",
				});
				await appendAuditEvent(tx, {
					...ctx,
					actorType: "worker",
					actorId: input.workerId,
					action: isBlocked ? "development.block" : "development.fail",
					targetType: "development_attempt",
					targetId: attempt.id,
					result: "failure",
					priorValues: { featureState: feature.state, attemptStatus: attempt.status },
					nextValues: { featureState: input.targetState, attemptStatus: "FAILED" },
				});
			});
		},
	};
}
