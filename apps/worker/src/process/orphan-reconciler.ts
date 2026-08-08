/**
 * Orphan reconciler — called on worker restart or lost ownership.
 * Marks interrupted attempts and does NOT automatically relaunch.
 */

import type {
	DevelopmentAttemptRow,
	FeatureRow,
	Queryable,
} from "../../../../packages/database/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	appendFailureRecord,
	updateAttemptStatus,
} from "../../../../packages/database/src/index";
import { applyFeatureTransition, mapFailure } from "../../../../packages/domain/src/index";

export interface OrphanReconciler {
	/**
	 * Reconcile a single orphaned attempt.
	 * Marks the attempt INTERRUPTED and feature DEVELOPMENT_INTERRUPTED.
	 * Idempotent: no-op if already interrupted or cancelled.
	 */
	reconcileOne(attempt: DevelopmentAttemptRow, feature: FeatureRow): Promise<void>;
}

export interface OrphanReconcilerOptions {
	sql: Queryable;
	now?: () => Date;
}

export function createOrphanReconciler(options: OrphanReconcilerOptions): OrphanReconciler {
	const { sql } = options;
	const now = options.now ?? (() => new Date());

	return { reconcileOne };

	async function reconcileOne(attempt: DevelopmentAttemptRow, feature: FeatureRow): Promise<void> {
		// Idempotent: only reconcile RUNNING (or CANCEL_REQUESTED where expired) attempts
		if (
			!(["RUNNING", "CANCEL_REQUESTED"] as const).includes(
				attempt.status as "RUNNING" | "CANCEL_REQUESTED",
			)
		) {
			return;
		}

		const operationId = `orphan:${attempt.id}:interrupted-${now().getTime()}`;

		const transition = applyFeatureTransition(
			{
				featureId: feature.id,
				from: feature.state,
				to: "DEVELOPMENT_INTERRUPTED",
				owner: "reconciliation",
				cause: "Worker lost or restarted — lease expired without graceful exit",
				operationId,
				expectedVersion: feature.rowVersion,
				currentVersion: feature.rowVersion,
				observedState: feature.state,
			},
			{ now },
		);

		if (transition.kind !== "applied") {
			// Already in expected state or version conflict — safe to skip
			return;
		}

		const rows = await sql`
      UPDATE features
      SET state = ${transition.nextState},
          row_version = ${transition.nextVersion},
          updated_at = now()
      WHERE id = ${feature.id}
        AND state = ${transition.priorState}
        AND row_version = ${transition.priorVersion}
      RETURNING id
    `;
		if (!rows[0]) return;

		await updateAttemptStatus(sql, attempt.id, {
			status: "INTERRUPTED",
			endedAt: now(),
		});

		const projection = mapFailure({
			kind: "interruption",
			detail: "Worker lost or restarted — orphaned attempt marked interrupted.",
		});

		await appendFailureRecord(sql, {
			projectId: attempt.projectId,
			featureId: attempt.featureId,
			attemptId: attempt.id,
			category: projection.kind,
			summary: projection.summary,
			recommendedAction: projection.recommendedAction,
		});

		await appendActivityEvent(sql, {
			projectId: attempt.projectId,
			featureId: attempt.featureId,
			attemptId: attempt.id,
			type: "development.interrupted",
			summary: "Development interrupted: worker lost or restarted.",
			source: "reconciliation",
		});

		await appendAuditEvent(sql, {
			actorType: "reconciliation",
			actorId: "orphan-reconciler",
			action: "development.interrupt",
			targetType: "development_attempt",
			targetId: attempt.id,
			projectId: attempt.projectId,
			featureId: attempt.featureId,
			attemptId: attempt.id,
			result: "interrupted",
			priorValues: { featureState: feature.state, attemptStatus: attempt.status },
			nextValues: { featureState: "DEVELOPMENT_INTERRUPTED", attemptStatus: "INTERRUPTED" },
		});
	}
}
