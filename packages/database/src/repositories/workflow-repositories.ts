import type postgres from "postgres";
import type { Queryable } from "../client";
import type {
	AuditActorType,
	DiagnosticStream,
	JobAttemptStatus,
	OutboxStatus,
	ScheduleStatus,
} from "../schema/enums";

/** Cast JSON payloads for postgres.js without repeating the type assertion. */
function asJson(sql: Queryable, value: unknown): ReturnType<Queryable["json"]> {
	return sql.json(value as postgres.JSONValue);
}

export interface WorkerRegistrationRow {
	id: string;
	workerId: string;
	hostname: string;
	capacity: number;
	activeJobs: number;
	registeredAt: Date;
	lastHeartbeatAt: Date;
	stoppedAt: Date | null;
}

export interface DevelopmentAttemptRow {
	id: string;
	projectId: string;
	featureId: string;
	taskApprovalId: string;
	branchName: string;
	operationKey: string;
	status: JobAttemptStatus;
	predecessorAttemptId: string | null;
	workerRegistrationId: string | null;
	processPid: number | null;
	processStartIdentity: string | null;
	leaseExpiresAt: Date | null;
	heartbeatAt: Date | null;
	enqueuedAt: Date;
	startedAt: Date | null;
	endedAt: Date | null;
	exitCode: number | null;
	cancellationRequestedAt: Date | null;
	cancellationReason: string | null;
	structuredResult: unknown | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ProgressSnapshotRow {
	id: string;
	projectId: string;
	featureId: string;
	attemptId: string;
	sourceVersion: number;
	summary: unknown;
	requirements: unknown;
	createdAt: Date;
}

export interface DiagnosticLogChunkRow {
	id: string;
	projectId: string;
	attemptId: string;
	sequence: number;
	stream: DiagnosticStream;
	body: string;
	truncated: boolean;
	createdAt: Date;
}

export interface FailureRecordRow {
	id: string;
	projectId: string;
	featureId: string;
	attemptId: string | null;
	category: string;
	summary: string;
	recommendedAction: string;
	details: unknown;
	occurredAt: Date;
	createdAt: Date;
}

export interface ActivityEventRow {
	id: string;
	projectId: string | null;
	featureId: string | null;
	attemptId: string | null;
	type: string;
	summary: string;
	source: string;
	metadata: unknown;
	occurredAt: Date;
	createdAt: Date;
}

export interface AuditEventRow {
	id: string;
	actorType: AuditActorType;
	actorId: string;
	action: string;
	targetType: string;
	targetId: string;
	projectId: string | null;
	featureId: string | null;
	attemptId: string | null;
	correlationId: string | null;
	result: string;
	priorValues: unknown | null;
	nextValues: unknown | null;
	occurredAt: Date;
	createdAt: Date;
}

export interface ScheduledReconciliationRow {
	id: string;
	kind: string;
	projectId: string | null;
	featureId: string | null;
	status: ScheduleStatus;
	notBefore: Date;
	payload: unknown;
	claimedBy: string | null;
	claimedAt: Date | null;
	completedAt: Date | null;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface OutboxIntentRow {
	id: string;
	projectId: string;
	featureId: string | null;
	attemptId: string | null;
	kind: string;
	dedupeKey: string;
	status: OutboxStatus;
	payload: unknown;
	claimedBy: string | null;
	claimedAt: Date | null;
	completedAt: Date | null;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface IdempotencyRecordRow {
	id: string;
	operationKey: string;
	projectId: string;
	featureId: string | null;
	attemptId: string | null;
	result: unknown;
	createdAt: Date;
}

function mapWorker(row: Record<string, unknown>): WorkerRegistrationRow {
	return {
		id: row.id as string,
		workerId: row.worker_id as string,
		hostname: row.hostname as string,
		capacity: row.capacity as number,
		activeJobs: row.active_jobs as number,
		registeredAt: row.registered_at as Date,
		lastHeartbeatAt: row.last_heartbeat_at as Date,
		stoppedAt: (row.stopped_at as Date | null) ?? null,
	};
}

function mapAttempt(row: Record<string, unknown>): DevelopmentAttemptRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: row.feature_id as string,
		taskApprovalId: row.task_approval_id as string,
		branchName: row.branch_name as string,
		operationKey: row.operation_key as string,
		status: row.status as JobAttemptStatus,
		predecessorAttemptId: (row.predecessor_attempt_id as string | null) ?? null,
		workerRegistrationId: (row.worker_registration_id as string | null) ?? null,
		processPid: (row.process_pid as number | null) ?? null,
		processStartIdentity: (row.process_start_identity as string | null) ?? null,
		leaseExpiresAt: (row.lease_expires_at as Date | null) ?? null,
		heartbeatAt: (row.heartbeat_at as Date | null) ?? null,
		enqueuedAt: row.enqueued_at as Date,
		startedAt: (row.started_at as Date | null) ?? null,
		endedAt: (row.ended_at as Date | null) ?? null,
		exitCode: (row.exit_code as number | null) ?? null,
		cancellationRequestedAt: (row.cancellation_requested_at as Date | null) ?? null,
		cancellationReason: (row.cancellation_reason as string | null) ?? null,
		structuredResult: row.structured_result ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapProgress(row: Record<string, unknown>): ProgressSnapshotRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: row.feature_id as string,
		attemptId: row.attempt_id as string,
		sourceVersion: Number(row.source_version),
		summary: row.summary,
		requirements: row.requirements,
		createdAt: row.created_at as Date,
	};
}

function mapLog(row: Record<string, unknown>): DiagnosticLogChunkRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		attemptId: row.attempt_id as string,
		sequence: Number(row.sequence),
		stream: row.stream as DiagnosticStream,
		body: row.body as string,
		truncated: row.truncated as boolean,
		createdAt: row.created_at as Date,
	};
}

function mapFailure(row: Record<string, unknown>): FailureRecordRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: row.feature_id as string,
		attemptId: (row.attempt_id as string | null) ?? null,
		category: row.category as string,
		summary: row.summary as string,
		recommendedAction: row.recommended_action as string,
		details: row.details,
		occurredAt: row.occurred_at as Date,
		createdAt: row.created_at as Date,
	};
}

function mapActivity(row: Record<string, unknown>): ActivityEventRow {
	return {
		id: row.id as string,
		projectId: (row.project_id as string | null) ?? null,
		featureId: (row.feature_id as string | null) ?? null,
		attemptId: (row.attempt_id as string | null) ?? null,
		type: row.type as string,
		summary: row.summary as string,
		source: row.source as string,
		metadata: row.metadata,
		occurredAt: row.occurred_at as Date,
		createdAt: row.created_at as Date,
	};
}

function mapAudit(row: Record<string, unknown>): AuditEventRow {
	return {
		id: row.id as string,
		actorType: row.actor_type as AuditActorType,
		actorId: row.actor_id as string,
		action: row.action as string,
		targetType: row.target_type as string,
		targetId: row.target_id as string,
		projectId: (row.project_id as string | null) ?? null,
		featureId: (row.feature_id as string | null) ?? null,
		attemptId: (row.attempt_id as string | null) ?? null,
		correlationId: (row.correlation_id as string | null) ?? null,
		result: row.result as string,
		priorValues: row.prior_values ?? null,
		nextValues: row.next_values ?? null,
		occurredAt: row.occurred_at as Date,
		createdAt: row.created_at as Date,
	};
}

function mapSchedule(row: Record<string, unknown>): ScheduledReconciliationRow {
	return {
		id: row.id as string,
		kind: row.kind as string,
		projectId: (row.project_id as string | null) ?? null,
		featureId: (row.feature_id as string | null) ?? null,
		status: row.status as ScheduleStatus,
		notBefore: row.not_before as Date,
		payload: row.payload,
		claimedBy: (row.claimed_by as string | null) ?? null,
		claimedAt: (row.claimed_at as Date | null) ?? null,
		completedAt: (row.completed_at as Date | null) ?? null,
		lastError: (row.last_error as string | null) ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapOutbox(row: Record<string, unknown>): OutboxIntentRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: (row.feature_id as string | null) ?? null,
		attemptId: (row.attempt_id as string | null) ?? null,
		kind: row.kind as string,
		dedupeKey: row.dedupe_key as string,
		status: row.status as OutboxStatus,
		payload: row.payload,
		claimedBy: (row.claimed_by as string | null) ?? null,
		claimedAt: (row.claimed_at as Date | null) ?? null,
		completedAt: (row.completed_at as Date | null) ?? null,
		lastError: (row.last_error as string | null) ?? null,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function mapIdempotency(row: Record<string, unknown>): IdempotencyRecordRow {
	return {
		id: row.id as string,
		operationKey: row.operation_key as string,
		projectId: row.project_id as string,
		featureId: (row.feature_id as string | null) ?? null,
		attemptId: (row.attempt_id as string | null) ?? null,
		result: row.result,
		createdAt: row.created_at as Date,
	};
}

export async function createWorkerRegistration(
	sql: Queryable,
	input: { workerId: string; hostname: string; capacity?: number },
): Promise<WorkerRegistrationRow> {
	const rows = await sql`
		INSERT INTO worker_registrations (worker_id, hostname, capacity)
		VALUES (${input.workerId}, ${input.hostname}, ${input.capacity ?? 4})
		RETURNING *
	`;
	return mapWorker(rows[0] as Record<string, unknown>);
}

export async function heartbeatWorker(
	sql: Queryable,
	workerRegistrationId: string,
	input: { activeJobs?: number } = {},
): Promise<WorkerRegistrationRow> {
	const rows = await sql`
		UPDATE worker_registrations
		SET
			last_heartbeat_at = now(),
			active_jobs = COALESCE(${input.activeJobs ?? null}, active_jobs)
		WHERE id = ${workerRegistrationId}
		RETURNING *
	`;
	if (!rows[0]) throw new Error(`worker registration not found: ${workerRegistrationId}`);
	return mapWorker(rows[0] as Record<string, unknown>);
}

export async function createDevelopmentAttempt(
	sql: Queryable,
	input: {
		projectId: string;
		featureId: string;
		taskApprovalId: string;
		branchName: string;
		operationKey: string;
		status?: JobAttemptStatus;
		predecessorAttemptId?: string;
		workerRegistrationId?: string;
		processPid?: number;
		processStartIdentity?: string;
		leaseExpiresAt?: Date;
		heartbeatAt?: Date;
		cancellationRequestedAt?: Date;
		cancellationReason?: string;
		structuredResult?: unknown;
	},
): Promise<DevelopmentAttemptRow> {
	const status = input.status ?? "QUEUED";
	const rows = await sql`
		INSERT INTO development_job_attempts (
			project_id, feature_id, task_approval_id, branch_name, operation_key, status,
			predecessor_attempt_id, worker_registration_id, process_pid, process_start_identity,
			lease_expires_at, heartbeat_at, started_at, cancellation_requested_at,
			cancellation_reason, structured_result
		)
		VALUES (
			${input.projectId},
			${input.featureId},
			${input.taskApprovalId},
			${input.branchName},
			${input.operationKey},
			${status},
			${input.predecessorAttemptId ?? null},
			${input.workerRegistrationId ?? null},
			${input.processPid ?? null},
			${input.processStartIdentity ?? null},
			${input.leaseExpiresAt ?? null},
			${input.heartbeatAt ?? null},
			${status === "RUNNING" || status === "CANCEL_REQUESTED" ? new Date() : null},
			${input.cancellationRequestedAt ?? null},
			${input.cancellationReason ?? null},
			${input.structuredResult !== undefined ? asJson(sql, input.structuredResult) : null}
		)
		RETURNING *
	`;
	return mapAttempt(rows[0] as Record<string, unknown>);
}

export async function getDevelopmentAttempt(
	sql: Queryable,
	id: string,
): Promise<DevelopmentAttemptRow | null> {
	const rows = await sql`SELECT * FROM development_job_attempts WHERE id = ${id}`;
	return rows[0] ? mapAttempt(rows[0] as Record<string, unknown>) : null;
}

export async function updateAttemptStatus(
	sql: Queryable,
	id: string,
	input: {
		status: JobAttemptStatus;
		endedAt?: Date;
		exitCode?: number;
		structuredResult?: unknown;
		cancellationRequestedAt?: Date;
		cancellationReason?: string;
		workerRegistrationId?: string | null;
		processPid?: number | null;
		processStartIdentity?: string | null;
		leaseExpiresAt?: Date | null;
		heartbeatAt?: Date | null;
		startedAt?: Date | null;
	},
): Promise<DevelopmentAttemptRow> {
	const rows = await sql`
		UPDATE development_job_attempts
		SET
			status = ${input.status},
			ended_at = COALESCE(${input.endedAt ?? null}, ended_at),
			exit_code = COALESCE(${input.exitCode ?? null}, exit_code),
			structured_result = COALESCE(
				${input.structuredResult !== undefined ? asJson(sql, input.structuredResult) : null},
				structured_result
			),
			cancellation_requested_at = COALESCE(${input.cancellationRequestedAt ?? null}, cancellation_requested_at),
			cancellation_reason = COALESCE(${input.cancellationReason ?? null}, cancellation_reason),
			worker_registration_id = COALESCE(${input.workerRegistrationId ?? null}, worker_registration_id),
			process_pid = COALESCE(${input.processPid ?? null}, process_pid),
			process_start_identity = COALESCE(${input.processStartIdentity ?? null}, process_start_identity),
			lease_expires_at = COALESCE(${input.leaseExpiresAt ?? null}, lease_expires_at),
			heartbeat_at = COALESCE(${input.heartbeatAt ?? null}, heartbeat_at),
			started_at = COALESCE(${input.startedAt ?? null}, started_at),
			updated_at = now()
		WHERE id = ${id}
		RETURNING *
	`;
	if (!rows[0]) throw new Error(`development attempt not found: ${id}`);
	return mapAttempt(rows[0] as Record<string, unknown>);
}

export async function renewLease(
	sql: Queryable,
	input: {
		attemptId: string;
		workerRegistrationId: string;
		leaseExpiresAt: Date;
	},
): Promise<DevelopmentAttemptRow> {
	const rows = await sql`
		UPDATE development_job_attempts
		SET
			lease_expires_at = ${input.leaseExpiresAt},
			heartbeat_at = now(),
			updated_at = now()
		WHERE id = ${input.attemptId}
			AND worker_registration_id = ${input.workerRegistrationId}
			AND status IN ('RUNNING', 'CANCEL_REQUESTED')
		RETURNING *
	`;
	if (!rows[0]) {
		throw new Error(`lease renew denied: owner mismatch or attempt not found (${input.attemptId})`);
	}
	return mapAttempt(rows[0] as Record<string, unknown>);
}

export async function appendProgressSnapshot(
	sql: Queryable,
	input: {
		projectId: string;
		featureId: string;
		attemptId: string;
		sourceVersion: number;
		summary: unknown;
		requirements: unknown;
	},
): Promise<ProgressSnapshotRow> {
	const rows = await sql`
		INSERT INTO progress_snapshots (
			project_id, feature_id, attempt_id, source_version, summary, requirements
		)
		VALUES (
			${input.projectId},
			${input.featureId},
			${input.attemptId},
			${input.sourceVersion},
			${asJson(sql, input.summary)},
			${asJson(sql, input.requirements)}
		)
		RETURNING *
	`;
	return mapProgress(rows[0] as Record<string, unknown>);
}

export async function appendDiagnosticLogChunk(
	sql: Queryable,
	input: {
		projectId: string;
		attemptId: string;
		sequence: number;
		stream: DiagnosticStream;
		body: string;
		truncated?: boolean;
	},
): Promise<DiagnosticLogChunkRow> {
	const rows = await sql`
		INSERT INTO diagnostic_log_chunks (
			project_id, attempt_id, sequence, stream, body, truncated
		)
		VALUES (
			${input.projectId},
			${input.attemptId},
			${input.sequence},
			${input.stream},
			${input.body},
			${input.truncated ?? false}
		)
		RETURNING *
	`;
	return mapLog(rows[0] as Record<string, unknown>);
}

export async function appendFailureRecord(
	sql: Queryable,
	input: {
		projectId: string;
		featureId: string;
		attemptId?: string;
		category: string;
		summary: string;
		recommendedAction: string;
		details?: unknown;
	},
): Promise<FailureRecordRow> {
	const rows = await sql`
		INSERT INTO failure_records (
			project_id, feature_id, attempt_id, category, summary, recommended_action, details
		)
		VALUES (
			${input.projectId},
			${input.featureId},
			${input.attemptId ?? null},
			${input.category},
			${input.summary},
			${input.recommendedAction},
			${asJson(sql, input.details ?? {})}
		)
		RETURNING *
	`;
	return mapFailure(rows[0] as Record<string, unknown>);
}

export async function appendActivityEvent(
	sql: Queryable,
	input: {
		projectId?: string;
		featureId?: string;
		attemptId?: string;
		type: string;
		summary: string;
		source: string;
		metadata?: unknown;
	},
): Promise<ActivityEventRow> {
	const rows = await sql`
		INSERT INTO activity_events (
			project_id, feature_id, attempt_id, type, summary, source, metadata
		)
		VALUES (
			${input.projectId ?? null},
			${input.featureId ?? null},
			${input.attemptId ?? null},
			${input.type},
			${input.summary},
			${input.source},
			${asJson(sql, input.metadata ?? {})}
		)
		RETURNING *
	`;
	return mapActivity(rows[0] as Record<string, unknown>);
}

export async function countActiveAttemptsForProject(
	sql: Queryable,
	projectId: string,
): Promise<number> {
	const rows = await sql`
		SELECT count(*)::int AS n
		FROM development_job_attempts
		WHERE project_id = ${projectId}
			AND status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
	`;
	return (rows[0]?.n as number) ?? 0;
}

export async function countActiveAttemptsForRelease(
	sql: Queryable,
	releaseId: string,
): Promise<number> {
	const rows = await sql`
		SELECT count(*)::int AS n
		FROM development_job_attempts a
		INNER JOIN features f ON f.id = a.feature_id
		WHERE f.release_id = ${releaseId}
			AND a.status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
	`;
	return (rows[0]?.n as number) ?? 0;
}

export async function listAuditEventsForTarget(
	sql: Queryable,
	input: { targetType: string; targetId: string },
): Promise<AuditEventRow[]> {
	const rows = await sql`
		SELECT * FROM audit_events
		WHERE target_type = ${input.targetType} AND target_id = ${input.targetId}
		ORDER BY occurred_at ASC, created_at ASC
	`;
	return rows.map((row) => mapAudit(row as Record<string, unknown>));
}

export async function appendAuditEvent(
	sql: Queryable,
	input: {
		actorType: AuditActorType;
		actorId: string;
		action: string;
		targetType: string;
		targetId: string;
		projectId?: string;
		featureId?: string;
		attemptId?: string;
		correlationId?: string;
		result: string;
		priorValues?: unknown | null;
		nextValues?: unknown | null;
	},
): Promise<AuditEventRow> {
	const rows = await sql`
		INSERT INTO audit_events (
			actor_type, actor_id, action, target_type, target_id,
			project_id, feature_id, attempt_id, correlation_id, result,
			prior_values, next_values
		)
		VALUES (
			${input.actorType},
			${input.actorId},
			${input.action},
			${input.targetType},
			${input.targetId},
			${input.projectId ?? null},
			${input.featureId ?? null},
			${input.attemptId ?? null},
			${input.correlationId ?? null},
			${input.result},
			${
				input.priorValues !== undefined && input.priorValues !== null
					? asJson(sql, input.priorValues)
					: null
			},
			${
				input.nextValues !== undefined && input.nextValues !== null
					? asJson(sql, input.nextValues)
					: null
			}
		)
		RETURNING *
	`;
	return mapAudit(rows[0] as Record<string, unknown>);
}

export async function createScheduledReconciliation(
	sql: Queryable,
	input: {
		kind: string;
		projectId?: string;
		featureId?: string;
		notBefore?: Date;
		payload?: unknown;
	},
): Promise<ScheduledReconciliationRow> {
	const rows = await sql`
		INSERT INTO scheduled_reconciliation_jobs (
			kind, project_id, feature_id, not_before, payload
		)
		VALUES (
			${input.kind},
			${input.projectId ?? null},
			${input.featureId ?? null},
			${input.notBefore ?? new Date()},
			${asJson(sql, input.payload ?? {})}
		)
		RETURNING *
	`;
	return mapSchedule(rows[0] as Record<string, unknown>);
}

export async function claimScheduledReconciliation(
	sql: Queryable,
	input: { scheduleId: string; workerId: string },
): Promise<ScheduledReconciliationRow | null> {
	const rows = await sql`
		UPDATE scheduled_reconciliation_jobs
		SET
			status = 'claimed',
			claimed_by = ${input.workerId},
			claimed_at = now(),
			updated_at = now()
		WHERE id = ${input.scheduleId}
			AND status = 'pending'
			AND not_before <= now()
		RETURNING *
	`;
	return rows[0] ? mapSchedule(rows[0] as Record<string, unknown>) : null;
}

export async function createOutboxIntent(
	sql: Queryable,
	input: {
		projectId: string;
		featureId?: string;
		attemptId?: string;
		kind: string;
		dedupeKey: string;
		payload?: unknown;
	},
): Promise<OutboxIntentRow> {
	const rows = await sql`
		INSERT INTO outbox_intents (
			project_id, feature_id, attempt_id, kind, dedupe_key, payload
		)
		VALUES (
			${input.projectId},
			${input.featureId ?? null},
			${input.attemptId ?? null},
			${input.kind},
			${input.dedupeKey},
			${asJson(sql, input.payload ?? {})}
		)
		RETURNING *
	`;
	return mapOutbox(rows[0] as Record<string, unknown>);
}

export async function claimOutboxIntent(
	sql: Queryable,
	input: { intentId: string; workerId: string },
): Promise<OutboxIntentRow | null> {
	const rows = await sql`
		UPDATE outbox_intents
		SET
			status = 'claimed',
			claimed_by = ${input.workerId},
			claimed_at = now(),
			updated_at = now()
		WHERE id = ${input.intentId}
			AND status = 'pending'
		RETURNING *
	`;
	return rows[0] ? mapOutbox(rows[0] as Record<string, unknown>) : null;
}

/** Atomically claim the next pending outbox intent of an optional kind (FIFO). */
export async function claimNextOutboxIntent(
	sql: Queryable,
	input: { workerId: string; kind?: string },
): Promise<OutboxIntentRow | null> {
	const capable = sql as Queryable & {
		begin?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
	};
	const claim = async (tx: Queryable): Promise<OutboxIntentRow | null> => {
		const candidates =
			input.kind === undefined
				? await tx`
						SELECT id
						FROM outbox_intents
						WHERE status = 'pending'
						ORDER BY created_at ASC, id ASC
						LIMIT 1
						FOR UPDATE SKIP LOCKED
					`
				: await tx`
						SELECT id
						FROM outbox_intents
						WHERE status = 'pending'
							AND kind = ${input.kind}
						ORDER BY created_at ASC, id ASC
						LIMIT 1
						FOR UPDATE SKIP LOCKED
					`;
		const id = candidates[0]?.id as string | undefined;
		if (!id) return null;
		const rows = await tx`
			UPDATE outbox_intents
			SET
				status = 'claimed',
				claimed_by = ${input.workerId},
				claimed_at = now(),
				updated_at = now()
			WHERE id = ${id}
				AND status = 'pending'
			RETURNING *
		`;
		return rows[0] ? mapOutbox(rows[0] as Record<string, unknown>) : null;
	};
	if (typeof capable.begin === "function") {
		return capable.begin((tx) => claim(tx));
	}
	return claim(sql);
}

export async function completeOutboxIntent(
	sql: Queryable,
	input: { intentId: string; workerId: string },
): Promise<OutboxIntentRow | null> {
	const rows = await sql`
		UPDATE outbox_intents
		SET
			status = 'completed',
			completed_at = now(),
			updated_at = now(),
			last_error = NULL
		WHERE id = ${input.intentId}
			AND status = 'claimed'
			AND claimed_by = ${input.workerId}
		RETURNING *
	`;
	return rows[0] ? mapOutbox(rows[0] as Record<string, unknown>) : null;
}

export async function failOutboxIntent(
	sql: Queryable,
	input: { intentId: string; workerId: string; error: string },
): Promise<OutboxIntentRow | null> {
	const rows = await sql`
		UPDATE outbox_intents
		SET
			status = 'failed',
			completed_at = now(),
			updated_at = now(),
			last_error = ${input.error}
		WHERE id = ${input.intentId}
			AND status = 'claimed'
			AND claimed_by = ${input.workerId}
		RETURNING *
	`;
	return rows[0] ? mapOutbox(rows[0] as Record<string, unknown>) : null;
}

export async function createIdempotencyRecord(
	sql: Queryable,
	input: {
		operationKey: string;
		projectId: string;
		featureId?: string;
		attemptId?: string;
		result: unknown;
	},
): Promise<IdempotencyRecordRow> {
	const rows = await sql`
		INSERT INTO idempotency_records (
			operation_key, project_id, feature_id, attempt_id, result
		)
		VALUES (
			${input.operationKey},
			${input.projectId},
			${input.featureId ?? null},
			${input.attemptId ?? null},
			${asJson(sql, input.result)}
		)
		RETURNING *
	`;
	return mapIdempotency(rows[0] as Record<string, unknown>);
}
