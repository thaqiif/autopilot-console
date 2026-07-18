import type { Queryable } from "../client";

export interface LeaseReconcilerOptions {
	/** Injectable clock for test determinism. */
	clock?: () => Date;
}

export interface LeaseReconciler {
	/**
	 * Find all RUNNING or CANCEL_REQUESTED attempts whose lease has expired
	 * and transition them to INTERRUPTED. Returns the count of interrupted attempts.
	 *
	 * Does NOT automatically requeue or relaunch.
	 */
	interruptExpiredLeases(): Promise<number>;
}

export function createLeaseReconciler(
	sql: Queryable,
	options?: LeaseReconcilerOptions,
): LeaseReconciler {
	const clock = options?.clock ?? (() => new Date());

	return { interruptExpiredLeases };

	async function interruptExpiredLeases(): Promise<number> {
		const now = clock();

		const result = await sql`
			UPDATE development_job_attempts
			SET
				status = 'INTERRUPTED',
				ended_at = ${now},
				updated_at = now()
			WHERE status IN ('RUNNING', 'CANCEL_REQUESTED')
				AND lease_expires_at IS NOT NULL
				AND lease_expires_at < ${now}
		`;

		return result.count;
	}
}
