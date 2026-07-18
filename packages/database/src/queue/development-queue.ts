import type { Queryable, TransactionSql } from "../client";
import type { DevelopmentAttemptRow } from "../repositories/workflow-repositories";

type TxCapable = Queryable & {
	begin?: <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;
};

export interface DevelopmentQueueOptions {
	/** Maximum concurrent running attempts across all projects. Default 4. */
	maxConcurrent?: number;
	/** Lease duration in milliseconds. Default 30_000. */
	leaseDurationMs?: number;
	/** Injectable clock for test determinism. */
	clock?: () => Date;
}

export interface ClaimAttemptResult {
	attempt: DevelopmentAttemptRow;
}

export interface DevelopmentQueue {
	/**
	 * Claim the next eligible QUEUED attempt for the given worker.
	 *
	 * Eligibility: FIFO by enqueued_at, project has no active attempt,
	 * and global running count is below maxConcurrent.
	 *
	 * The claim is transactional with SKIP LOCKED semantics so
	 * concurrent workers cannot claim the same attempt.
	 *
	 * Returns null when no work is available.
	 */
	claimNextAttempt(workerId: string): Promise<ClaimAttemptResult | null>;
}

function mapAttemptRow(row: Record<string, unknown>): DevelopmentAttemptRow {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		featureId: row.feature_id as string,
		taskApprovalId: row.task_approval_id as string,
		branchName: row.branch_name as string,
		operationKey: row.operation_key as string,
		status: row.status as DevelopmentAttemptRow["status"],
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

export function createDevelopmentQueue(
	sql: Queryable,
	options?: DevelopmentQueueOptions,
): DevelopmentQueue {
	const maxConcurrent = options?.maxConcurrent ?? 4;
	const leaseDurationMs = options?.leaseDurationMs ?? 30_000;
	const clock = options?.clock ?? (() => new Date());

	return { claimNextAttempt };

	async function claimNextAttempt(workerId: string): Promise<ClaimAttemptResult | null> {
		const capable = sql as TxCapable;
		if (typeof capable.begin === "function") {
			return capable.begin(async (nested) => doClaim(nested, workerId));
		}
		return doClaim(sql, workerId);
	}

	async function doClaim(nested: Queryable, workerId: string): Promise<ClaimAttemptResult | null> {
		const now = clock();
		const leaseExpires = new Date(now.getTime() + leaseDurationMs);

		// Verify the worker registration exists and is not stopped
		const workers = await nested`
			SELECT id FROM worker_registrations
			WHERE worker_id = ${workerId} AND stopped_at IS NULL
			LIMIT 1
		`;
		if (workers.length === 0) return null;
		const firstWorker = workers[0];
		if (!firstWorker) return null;
		const workerRegId = firstWorker.id as string;

		// Count active (RUNNING or CANCEL_REQUESTED) attempts globally
		const countRows = await nested`
			SELECT count(*)::int AS n
			FROM development_job_attempts
			WHERE status IN ('RUNNING', 'CANCEL_REQUESTED')
		`;
		const activeCount = (countRows[0]?.n as number) ?? 0;
		if (activeCount >= maxConcurrent) return null;

		// Find the oldest QUEUED attempt whose project does NOT have
		// an active (RUNNING / CANCEL_REQUESTED) attempt.
		// SKIP LOCKED prevents concurrent claims from blocking each other.
		const candidates = await nested`
			SELECT a.id
			FROM development_job_attempts a
			WHERE a.status = 'QUEUED'
				AND NOT EXISTS (
					SELECT 1 FROM development_job_attempts b
					WHERE b.project_id = a.project_id
						AND b.status IN ('RUNNING', 'CANCEL_REQUESTED')
				)
			ORDER BY a.enqueued_at ASC, a.id ASC
			LIMIT 1
			FOR UPDATE OF a SKIP LOCKED
		`;
		if (candidates.length === 0) return null;
		const first = candidates[0];
		if (!first) return null;
		const targetId = first.id as string;

		// Atomically update the attempt
		const rows = await nested`
			UPDATE development_job_attempts
			SET
				status = 'RUNNING',
				worker_registration_id = ${workerRegId},
				started_at = ${now},
				lease_expires_at = ${leaseExpires},
				heartbeat_at = ${now},
				updated_at = now()
			WHERE id = ${targetId}
				AND status = 'QUEUED'
			RETURNING *
		`;
		if (rows.length === 0) return null;

		return { attempt: mapAttemptRow(rows[0] as Record<string, unknown>) };
	}
}
