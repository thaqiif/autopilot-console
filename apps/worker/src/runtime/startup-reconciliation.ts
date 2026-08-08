import {
	getDevelopmentAttempt,
	getFeatureById,
	type Sql,
} from "../../../../packages/database/src/index";
import { createOrphanReconciler } from "../process/orphan-reconciler";

export interface WorkerStartupReconciliationOptions {
	now?: () => Date;
}

/**
 * Reconcile attempts whose ownership lease had already expired when this worker started.
 * Each attempt is re-checked under lock and the complete orphan projection is transactional.
 */
export async function reconcileOrphansAtWorkerStartup(
	sql: Sql,
	options: WorkerStartupReconciliationOptions = {},
): Promise<number> {
	const observedAt = (options.now ?? (() => new Date()))();
	const candidates = await sql`
		SELECT id
		FROM development_job_attempts
		WHERE status IN ('RUNNING', 'CANCEL_REQUESTED')
			AND lease_expires_at IS NOT NULL
			AND lease_expires_at < ${observedAt}
		ORDER BY lease_expires_at, id
	`;

	let reconciled = 0;
	for (const candidate of candidates) {
		const applied = await sql.begin(async (tx) => {
			const [lockedAttempt] = await tx`
				SELECT id
				FROM development_job_attempts
				WHERE id = ${candidate.id as string}
					AND status IN ('RUNNING', 'CANCEL_REQUESTED')
					AND lease_expires_at IS NOT NULL
					AND lease_expires_at < ${observedAt}
				FOR UPDATE
			`;
			if (!lockedAttempt) return false;

			const attempt = await getDevelopmentAttempt(tx, candidate.id as string);
			if (!attempt) return false;
			await tx`SELECT id FROM features WHERE id = ${attempt.featureId} FOR UPDATE`;
			const feature = await getFeatureById(tx, attempt.featureId);
			if (!feature) {
				throw new Error(`feature not found for orphaned attempt: ${attempt.id}`);
			}

			await createOrphanReconciler({ sql: tx, now: () => observedAt }).reconcileOne(
				attempt,
				feature,
			);
			const updated = await getDevelopmentAttempt(tx, attempt.id);
			return updated?.status === "INTERRUPTED";
		});
		if (applied) reconciled += 1;
	}

	return reconciled;
}
