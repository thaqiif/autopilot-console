/**
 * Job-command worker — consumes durable CANCEL_REQUESTED commands and exposes
 * worker-owned retry/orphan reconciliation composition for production.
 *
 * Process control never runs in HTTP request scope; this module is the
 * production boundary that owns running cancellation escalation.
 */

import type { AutopilotRunHandle } from "../../../../packages/autopilot/src/index";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	Queryable,
	Sql,
} from "../../../../packages/database/src/index";
import { getDevelopmentAttempt, getFeatureById } from "../../../../packages/database/src/index";
import type { CancellationController, CancelOutcome } from "../process/cancellation-controller";
import type { RetryOutcome, RetryRequest, RetryService } from "../process/retry-service";

export type JobCommandCancelOutcome = {
	attemptId: string;
	outcome: CancelOutcome;
};

export type ProcessPendingCancelsResult = {
	cancelsProcessed: number;
	outcomes: JobCommandCancelOutcome[];
};

export interface JobCommandWorker {
	/** Claim and escalate every CANCEL_REQUESTED attempt owned by this worker. */
	processPendingCancels(): Promise<ProcessPendingCancelsResult>;
	/** Worker-owned safe retry (liveness verified via process tree / Autopilot). */
	retry(request: RetryRequest): Promise<RetryOutcome>;
	/** Startup / periodic orphan reconciliation; returns reconciled count. */
	reconcileOrphans(): Promise<number>;
	/** Poll loop that drains cancel commands until aborted. */
	run(signal: AbortSignal): Promise<void>;
}

export interface JobCommandWorkerOptions {
	sql: Queryable;
	workerRegistrationId: string;
	cancellation: CancellationController;
	retry: RetryService;
	reconcileOrphans: () => Promise<number>;
	/** Optional worker id retained for logging/composition identity. */
	workerId?: string;
	pollIntervalMs?: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function toHandle(attempt: DevelopmentAttemptRow): AutopilotRunHandle {
	return {
		projectId: attempt.projectId,
		featureId: attempt.featureId,
		projectRoot: "",
		taskRelativePath: "",
		expectedBranch: attempt.branchName,
		processIdentity: {
			pid: attempt.processPid ?? 0,
			startTimeMs: Number(attempt.processStartIdentity ?? 0),
		},
		startedAt: (attempt.startedAt ?? attempt.enqueuedAt).toISOString(),
	};
}

async function loadOwnedCancelRequested(
	sql: Queryable,
	attemptId: string,
	workerRegistrationId: string,
): Promise<{ attempt: DevelopmentAttemptRow; feature: FeatureRow } | null> {
	const capable = sql as Sql;
	if (typeof capable.begin === "function") {
		return capable.begin(async (tx) => {
			const [locked] = await tx`
				SELECT id
				FROM development_job_attempts
				WHERE id = ${attemptId}
					AND status = 'CANCEL_REQUESTED'
					AND worker_registration_id = ${workerRegistrationId}
				FOR UPDATE
			`;
			if (!locked) return null;
			const attempt = await getDevelopmentAttempt(tx, attemptId);
			if (!attempt) return null;
			const feature = await getFeatureById(tx, attempt.featureId);
			if (!feature) return null;
			return { attempt, feature };
		});
	}

	const attempt = await getDevelopmentAttempt(sql, attemptId);
	if (
		attempt?.status !== "CANCEL_REQUESTED" ||
		attempt.workerRegistrationId !== workerRegistrationId
	) {
		return null;
	}
	const feature = await getFeatureById(sql, attempt.featureId);
	if (!feature) return null;
	return { attempt, feature };
}

export function createJobCommandWorker(options: JobCommandWorkerOptions): JobCommandWorker {
	const pollIntervalMs = options.pollIntervalMs ?? 500;
	const sleep = options.sleep ?? defaultSleep;
	const sql = options.sql;

	return {
		processPendingCancels,
		retry: (request) => options.retry.retry(request),
		reconcileOrphans: () => options.reconcileOrphans(),
		run,
	};

	async function processPendingCancels(): Promise<ProcessPendingCancelsResult> {
		const candidates = await sql`
			SELECT id
			FROM development_job_attempts
			WHERE status = 'CANCEL_REQUESTED'
				AND worker_registration_id = ${options.workerRegistrationId}
			ORDER BY cancellation_requested_at NULLS FIRST, updated_at, id
		`;

		const outcomes: JobCommandCancelOutcome[] = [];
		for (const candidate of candidates) {
			const outcome = await processOneCancel(candidate.id as string);
			if (outcome) outcomes.push(outcome);
		}
		return { cancelsProcessed: outcomes.length, outcomes };
	}

	async function processOneCancel(attemptId: string): Promise<JobCommandCancelOutcome | null> {
		const owned = await loadOwnedCancelRequested(sql, attemptId, options.workerRegistrationId);
		if (!owned) return null;

		const { attempt, feature } = owned;
		const reason = attempt.cancellationReason ?? "owner requested stop";
		const operationId = `worker-cancel:${attempt.id}:${attempt.cancellationRequestedAt?.toISOString() ?? "now"}`;
		const outcome = await options.cancellation.cancelRunning(
			attempt,
			feature,
			toHandle(attempt),
			reason,
			operationId,
		);
		return { attemptId: attempt.id, outcome };
	}

	async function run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await processPendingCancels();
			await sleep(pollIntervalMs, signal);
		}
	}
}
