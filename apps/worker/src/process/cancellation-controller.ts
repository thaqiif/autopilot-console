import type { AutopilotRunHandle, SignalKind } from "../../../../packages/autopilot/src/index";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	Queryable,
} from "../../../../packages/database/src/index";
import {
	appendActivityEvent,
	appendAuditEvent,
	appendFailureRecord,
	getDevelopmentAttempt,
	updateAttemptStatus,
} from "../../../../packages/database/src/index";
import {
	applyFeatureTransition,
	type FeatureState,
	mapFailure,
	type TransitionOwner,
} from "../../../../packages/domain/src/index";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ProcessTreeInspector {
	getDescendants(pid: number): Promise<number[]>;
	verifyIdentity(pid: number, expectedStartTimeMs: number): Promise<boolean>;
	signal(pid: number, kind: SignalKind): Promise<void>;
}

export type CancelOutcome =
	| { kind: "cancelled"; attemptId: string }
	| { kind: "blocked"; attemptId: string; reason: string }
	| { kind: "idempotent"; attemptId: string };

export interface CancellationController {
	cancelQueued(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		reason: string,
		operationId: string,
	): Promise<CancelOutcome>;
	cancelRunning(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		handle: AutopilotRunHandle,
		reason: string,
		operationId: string,
	): Promise<CancelOutcome>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CancellationControllerOptions {
	tree: ProcessTreeInspector;
	sql: Queryable;
	graceMs?: number;
	killGraceMs?: number;
	now?: () => Date;
	/** Injectable delay for tests. Defaults to setTimeout-based delay. */
	sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory: createCancellationController
// ---------------------------------------------------------------------------

export function createCancellationController(
	options: CancellationControllerOptions,
): CancellationController {
	const tree = options.tree;
	const sql = options.sql;
	const graceMs = options.graceMs ?? 5_000;
	const killGraceMs = options.killGraceMs ?? 2_500;
	const now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? delay;

	return { cancelQueued, cancelRunning };

	// -------------------------------------------------------------------
	// Cancel QUEUED
	// -------------------------------------------------------------------

	async function cancelQueued(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		reason: string,
		operationId: string,
	): Promise<CancelOutcome> {
		// Idempotency check first via attempt status
		const fresh = await getDevelopmentAttempt(sql, attempt.id);
		if (fresh && fresh.status === "CANCELLED") {
			return { kind: "idempotent", attemptId: attempt.id };
		}

		if (attempt.status !== "QUEUED") {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Only QUEUED attempts can be cancelled.",
			};
		}

		await persistTransition({
			sql,
			attempt,
			feature,
			targetState: "DEVELOPMENT_CANCELLED",
			attemptStatus: "CANCELLED",
			owner: "human",
			cause: reason,
			operationId,
			action: "development.cancel",
			activityType: "development.cancelled",
			activitySummary: `Development cancelled: ${reason}`,
			now: now(),
		});

		return { kind: "cancelled", attemptId: attempt.id };
	}

	// -------------------------------------------------------------------
	// Cancel RUNNING
	// -------------------------------------------------------------------

	async function cancelRunning(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		handle: AutopilotRunHandle,
		reason: string,
		operationId: string,
	): Promise<CancelOutcome> {
		const fresh = await getDevelopmentAttempt(sql, attempt.id);
		if (fresh && fresh.status === "CANCELLED") {
			return { kind: "idempotent", attemptId: attempt.id };
		}

		// Durable API requests leave RUNNING as CANCEL_REQUESTED; the owning worker
		// then escalates process control for either status.
		if (attempt.status !== "RUNNING" && attempt.status !== "CANCEL_REQUESTED") {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Only RUNNING or CANCEL_REQUESTED attempts can be process-cancelled.",
			};
		}

		// Verify project/feature identity on handle
		if (handle.projectId !== attempt.projectId || handle.featureId !== attempt.featureId) {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Mismatched project or feature identity on handle.",
			};
		}

		// Verify PID identity
		if (attempt.processPid === null || attempt.processStartIdentity === null) {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Cannot cancel attempt with no process identity.",
			};
		}

		const identityOk = await tree.verifyIdentity(
			attempt.processPid,
			Number(attempt.processStartIdentity),
		);
		if (!identityOk) {
			await persistBlocked({
				sql,
				attempt,
				feature,
				reason: "PID reuse detected — process replaced.",
				operationId,
				now: now(),
			});
			return { kind: "blocked", attemptId: attempt.id, reason: "PID reuse detected." };
		}

		// Persist CANCEL_REQUESTED
		await updateAttemptStatus(sql, attempt.id, {
			status: "CANCEL_REQUESTED",
			cancellationRequestedAt: now(),
			cancellationReason: reason,
		});

		// Send SIGUSR1 to wrapper PID
		await tree.signal(handle.processIdentity.pid, "graceful");

		// Wait grace period
		await sleep(graceMs);

		// Check if still alive
		const stillAlive = await tree.verifyIdentity(
			handle.processIdentity.pid,
			handle.processIdentity.startTimeMs,
		);

		if (stillAlive) {
			// SIGTERM to descendants, then wrapper
			const descendants = await tree.getDescendants(handle.processIdentity.pid);
			for (const d of descendants) {
				try {
					await tree.signal(d, "term");
				} catch {
					/* best-effort */
				}
			}
			try {
				await tree.signal(handle.processIdentity.pid, "term");
			} catch {
				/* best-effort */
			}

			await sleep(killGraceMs);

			const stillAliveAfterTerm = await tree.verifyIdentity(
				handle.processIdentity.pid,
				handle.processIdentity.startTimeMs,
			);
			if (stillAliveAfterTerm) {
				const remainingDescendants = await tree.getDescendants(handle.processIdentity.pid);
				for (const d of remainingDescendants) {
					try {
						await tree.signal(d, "kill");
					} catch {
						/* best-effort */
					}
				}
				try {
					await tree.signal(handle.processIdentity.pid, "kill");
				} catch {
					/* best-effort */
				}
			}
		}

		await persistTransition({
			sql,
			attempt,
			feature,
			targetState: "DEVELOPMENT_CANCELLED",
			attemptStatus: "CANCELLED",
			owner: "human_and_process_control",
			cause: reason,
			operationId,
			action: "development.cancel",
			activityType: "development.cancelled",
			activitySummary: `Development cancelled after process escalation: ${reason}`,
			now: now(),
		});

		return { kind: "cancelled", attemptId: attempt.id };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PersistTransitionInput {
	sql: Queryable;
	attempt: DevelopmentAttemptRow;
	feature: FeatureRow;
	targetState: FeatureState;
	attemptStatus: DevelopmentAttemptRow["status"];
	owner: TransitionOwner;
	cause: string;
	operationId: string;
	action: string;
	activityType: string;
	activitySummary: string;
	now: Date;
}

async function persistTransition(input: PersistTransitionInput): Promise<void> {
	const {
		sql,
		attempt,
		feature,
		targetState,
		attemptStatus,
		owner,
		cause,
		operationId,
		action,
		activityType,
		activitySummary,
		now,
	} = input;

	const transition = applyFeatureTransition(
		{
			featureId: feature.id,
			from: feature.state,
			to: targetState,
			owner,
			cause,
			operationId,
			expectedVersion: feature.rowVersion,
			currentVersion: feature.rowVersion,
			observedState: feature.state,
		},
		{ now: () => now },
	);
	if (transition.kind !== "applied") {
		throw new Error(
			transition.kind === "rejected"
				? transition.message
				: `feature transition was already applied: ${operationId}`,
		);
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
	if (!rows[0]) throw new Error(`feature transition conflict: ${feature.id}`);

	await updateAttemptStatus(sql, attempt.id, {
		status: attemptStatus,
		endedAt: now,
		cancellationRequestedAt: now,
		cancellationReason: cause,
	});

	await appendActivityEvent(sql, {
		projectId: attempt.projectId,
		featureId: attempt.featureId,
		attemptId: attempt.id,
		type: activityType,
		summary: activitySummary,
		source: "worker",
	});

	await appendAuditEvent(sql, {
		actorType: "worker",
		actorId: "cancellation-controller",
		action,
		targetType: "development_attempt",
		targetId: attempt.id,
		projectId: attempt.projectId,
		featureId: attempt.featureId,
		attemptId: attempt.id,
		result: "success",
		priorValues: { featureState: feature.state, attemptStatus: attempt.status },
		nextValues: { featureState: targetState, attemptStatus },
	});
}

interface PersistBlockedInput {
	sql: Queryable;
	attempt: DevelopmentAttemptRow;
	feature: FeatureRow;
	reason: string;
	operationId: string;
	now: Date;
}

async function persistBlocked(input: PersistBlockedInput): Promise<void> {
	const { sql, attempt, feature, reason, operationId, now } = input;
	const projection = mapFailure({ kind: "process", detail: reason });

	const transition = applyFeatureTransition(
		{
			featureId: feature.id,
			from: feature.state,
			to: "BLOCKED",
			owner: "guard",
			cause: reason,
			operationId: `${operationId}:blocked`,
			expectedVersion: feature.rowVersion,
			currentVersion: feature.rowVersion,
			observedState: feature.state,
		},
		{ now: () => now },
	);
	if (transition.kind !== "applied") {
		throw new Error(`failed to transition feature to BLOCKED: ${reason}`);
	}

	await sql`
    UPDATE features
    SET state = ${transition.nextState},
        row_version = ${transition.nextVersion},
        updated_at = now()
    WHERE id = ${feature.id}
      AND state = ${transition.priorState}
      AND row_version = ${transition.priorVersion}
    RETURNING id
  `;

	await updateAttemptStatus(sql, attempt.id, { status: "FAILED", endedAt: now });

	await appendFailureRecord(sql, {
		projectId: attempt.projectId,
		featureId: attempt.featureId,
		attemptId: attempt.id,
		category: projection.kind,
		summary: projection.summary,
		recommendedAction: projection.recommendedAction,
		details: projection.detail ? { detail: projection.detail } : {},
	});

	await appendActivityEvent(sql, {
		projectId: attempt.projectId,
		featureId: attempt.featureId,
		attemptId: attempt.id,
		type: "development.blocked",
		summary: reason,
		source: "worker",
	});

	await appendAuditEvent(sql, {
		actorType: "worker",
		actorId: "cancellation-controller",
		action: "development.block",
		targetType: "development_attempt",
		targetId: attempt.id,
		projectId: attempt.projectId,
		featureId: attempt.featureId,
		attemptId: attempt.id,
		result: "failure",
		priorValues: { featureState: feature.state, attemptStatus: attempt.status },
		nextValues: { featureState: "BLOCKED", attemptStatus: "FAILED" },
	});
}
