import type {
	AutopilotRunHandle,
	AutopilotRunner,
	NormalizedRunResult,
} from "../../../../packages/autopilot/src/index";
import type {
	DevelopmentAttemptRow,
	DevelopmentQueue,
	Queryable,
} from "../../../../packages/database/src/index";
import { mapFailure } from "../../../../packages/domain/src/index";
import type { GitGateway } from "../../../../packages/git/src/index";
import type {
	DiagnosticRetention,
	RuntimeMetricEvent,
	StructuredLogger,
} from "../../../../packages/shared/src/index";
import {
	createPostgresDevelopmentWorkerStore,
	type DevelopmentWorkerStore,
} from "./development-worker-store";
import {
	createPreflightOrchestrator,
	type DevelopmentExecutionContext,
	DevelopmentPreflightError,
} from "./preflight-orchestrator";
import { verifyDevelopmentResult } from "./result-verifier";

export interface HeartbeatScheduler {
	run<T>(intervalMs: number, heartbeat: () => Promise<void>, task: () => Promise<T>): Promise<T>;
}

export class IntervalHeartbeatScheduler implements HeartbeatScheduler {
	async run<T>(
		intervalMs: number,
		heartbeat: () => Promise<void>,
		task: () => Promise<T>,
	): Promise<T> {
		await heartbeat();
		let heartbeatFailure: unknown;
		const interval = setInterval(() => {
			void heartbeat().catch((error) => {
				heartbeatFailure = error;
			});
		}, intervalMs);
		try {
			const result = await task();
			if (heartbeatFailure !== undefined) throw heartbeatFailure;
			return result;
		} finally {
			clearInterval(interval);
		}
	}
}

export type DevelopmentWorkerOutcome =
	| { kind: "idle" }
	| { kind: "completed"; attemptId: string }
	| { kind: "failed"; attemptId: string; reason: string }
	| { kind: "blocked"; attemptId: string; reason: string };

export type DevelopmentWorkerBeginResult =
	| { kind: "idle" }
	| {
			kind: "started";
			attemptId: string;
			finished: Promise<DevelopmentWorkerOutcome>;
	  };

export interface DevelopmentWorker {
	/** Claim and fully execute one attempt. Sequential convenience for tests. */
	runOnce(): Promise<DevelopmentWorkerOutcome>;
	/**
	 * Claim one eligible attempt and start execution without awaiting completion.
	 * Returns idle when no work is available. Used by the concurrent production supervisor.
	 */
	beginOnce(): Promise<DevelopmentWorkerBeginResult>;
}

interface SharedDevelopmentWorkerOptions {
	queue: DevelopmentQueue;
	git: GitGateway;
	autopilot: AutopilotRunner;
	workerId: string;
	workerRegistrationId: string;
	remoteName?: string;
	leaseDurationMs?: number;
	heartbeatIntervalMs?: number;
	waitTimeoutMs?: number;
	heartbeatScheduler?: HeartbeatScheduler;
	now?: () => Date;
	/** Optional structured logger; job logs include correlation/project/feature/attempt/worker. */
	logger?: StructuredLogger;
	/** Optional metrics sink for real job lifecycle events. */
	onMetric?: (event: RuntimeMetricEvent) => void;
	/** Optional diagnostic retention writer for process stdout/stderr chunks. */
	diagnostics?: DiagnosticRetention;
}

export type DevelopmentWorkerOptions = SharedDevelopmentWorkerOptions &
	({ sql: Queryable; store?: never } | { store: DevelopmentWorkerStore; sql?: never });

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDevelopmentWorker(options: DevelopmentWorkerOptions): DevelopmentWorker {
	const now = options.now ?? (() => new Date());
	const leaseDurationMs = options.leaseDurationMs ?? 30_000;
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
	const heartbeatScheduler = options.heartbeatScheduler ?? new IntervalHeartbeatScheduler();
	const store = options.store ?? createPostgresDevelopmentWorkerStore(options.sql);
	const preflight = createPreflightOrchestrator({
		loadContext: (attempt) => store.loadContext(attempt),
		git: options.git,
		autopilot: options.autopilot,
		remoteName: options.remoteName,
	});

	return { runOnce, beginOnce };

	async function beginOnce(): Promise<DevelopmentWorkerBeginResult> {
		const claim = await options.queue.claimNextAttempt(options.workerId);
		if (!claim) return { kind: "idle" };
		const attemptId = claim.attempt.id;
		const finished = executeClaimed(claim.attempt);
		return { kind: "started", attemptId, finished };
	}

	async function runOnce(): Promise<DevelopmentWorkerOutcome> {
		const begun = await beginOnce();
		if (begun.kind === "idle") return { kind: "idle" };
		return begun.finished;
	}

	async function executeClaimed(
		claimedAttempt: DevelopmentAttemptRow,
	): Promise<DevelopmentWorkerOutcome> {
		const startedAt = now().getTime();
		const emit = (event: RuntimeMetricEvent) => options.onMetric?.(event);
		const durationMs = () => Math.max(0, now().getTime() - startedAt);
		const canonicalAttempt = await store.getAttempt(claimedAttempt.id);
		if (!canonicalAttempt) {
			return {
				kind: "blocked",
				attemptId: claimedAttempt.id,
				reason: "Claimed attempt no longer exists.",
			};
		}

		emit({ type: "job_start" });
		const jobLog = options.logger?.child({
			workerId: options.workerId,
			projectId: canonicalAttempt.projectId,
			featureId: canonicalAttempt.featureId,
			jobAttemptId: canonicalAttempt.id,
			adapter: "autopilot",
		});
		jobLog?.info("development attempt claimed");

		let context: DevelopmentExecutionContext;
		try {
			context = await preflight.prepare(claimedAttempt);
		} catch (error) {
			const preflightError =
				error instanceof DevelopmentPreflightError
					? error
					: new DevelopmentPreflightError("validation", errorMessage(error));
			if (preflightError.kind === "git") {
				emit({ type: "adapter_error", kind: "git" });
				jobLog?.error("preflight git failure", {
					adapter: "git",
					detail: preflightError.message,
				});
			}
			if (preflightError.safeToFailAttempt) {
				await store.persistFailure({
					attemptId: canonicalAttempt.id,
					workerRegistrationId: options.workerRegistrationId,
					workerId: options.workerId,
					failureKind: preflightError.kind,
					detail: preflightError.message,
					targetState: "BLOCKED",
					transitionOwner: "guard",
					now: now(),
				});
			}
			emit({ type: "job_fail", durationMs: durationMs() });
			return {
				kind: "blocked",
				attemptId: canonicalAttempt.id,
				reason: mapFailure({ kind: preflightError.kind, detail: preflightError.message }).summary,
			};
		}

		await store.markDeveloping(context, {
			workerRegistrationId: options.workerRegistrationId,
			workerId: options.workerId,
			now: now(),
		});

		let handle: AutopilotRunHandle;
		try {
			handle = await options.autopilot.start({
				projectRoot: context.project.canonicalPath,
				taskRelativePath: context.approval.relativeTaskPath,
				projectId: context.project.id,
				featureId: context.feature.id,
				expectedBranch: context.attempt.branchName,
			});
			const heartbeatAt = now();
			await store.persistProcessIdentity(context.attempt.id, {
				workerRegistrationId: options.workerRegistrationId,
				handle,
				heartbeatAt,
				leaseExpiresAt: new Date(heartbeatAt.getTime() + leaseDurationMs),
			});
			jobLog?.info("autopilot process started", {
				adapter: "autopilot",
				pid: handle.processIdentity.pid,
			});
		} catch (error) {
			return failExecution(context.attempt, errorMessage(error), durationMs, jobLog, emit);
		}

		let runResult: NormalizedRunResult;
		try {
			runResult = await heartbeatScheduler.run(
				heartbeatIntervalMs,
				() => heartbeat(context.attempt.id),
				() => options.autopilot.wait(handle, { timeoutMs: options.waitTimeoutMs }),
			);
		} catch (error) {
			return failExecution(context.attempt, errorMessage(error), durationMs, jobLog, emit);
		}

		if (options.diagnostics) {
			const correlationId = `job:${context.attempt.id}`;
			const chunks: Array<{ stream: "stdout" | "stderr"; body: string }> = [];
			if (runResult.stdoutDiagnostic) {
				chunks.push({ stream: "stdout", body: runResult.stdoutDiagnostic });
			}
			if (runResult.stderrDiagnostic) {
				chunks.push({ stream: "stderr", body: runResult.stderrDiagnostic });
			}
			await Promise.all(
				chunks.map((chunk) =>
					options.diagnostics?.write({
						...chunk,
						projectId: context.project.id,
						featureId: context.feature.id,
						jobAttemptId: context.attempt.id,
						correlationId,
					}),
				),
			);
		}

		const verified = verifyDevelopmentResult(runResult);
		if (!verified.ok) {
			await store.persistFailure({
				attemptId: context.attempt.id,
				workerRegistrationId: options.workerRegistrationId,
				workerId: options.workerId,
				failureKind: verified.failureKind,
				detail: verified.reason,
				targetState: "DEVELOPMENT_FAILED",
				transitionOwner: "worker",
				structuredResult: verified.result,
				now: now(),
			});
			if (runResult.outcome === "interrupted") {
				emit({ type: "job_interrupt", durationMs: durationMs() });
			} else {
				emit({ type: "job_fail", durationMs: durationMs() });
			}
			jobLog?.warn("development attempt failed", {
				adapter: "autopilot",
				reason: verified.reason,
				failureKind: verified.failureKind,
			});
			return {
				kind: "failed",
				attemptId: context.attempt.id,
				reason: mapFailure({
					kind: verified.failureKind,
					detail: verified.reason,
				}).summary,
			};
		}

		await store.persistSuccess(context.attempt.id, {
			workerRegistrationId: options.workerRegistrationId,
			workerId: options.workerId,
			result: verified.result,
			now: now(),
		});
		emit({ type: "job_complete", durationMs: durationMs() });
		jobLog?.info("development attempt completed", { adapter: "autopilot" });
		return { kind: "completed", attemptId: context.attempt.id };
	}

	async function heartbeat(attemptId: string): Promise<void> {
		const heartbeatAt = now();
		await store.heartbeat(attemptId, {
			workerRegistrationId: options.workerRegistrationId,
			leaseExpiresAt: new Date(heartbeatAt.getTime() + leaseDurationMs),
		});
	}

	async function failExecution(
		attempt: DevelopmentAttemptRow,
		detail: string,
		durationMs: () => number,
		log: StructuredLogger | undefined,
		emit: (event: RuntimeMetricEvent) => void,
	): Promise<DevelopmentWorkerOutcome> {
		await store.persistFailure({
			attemptId: attempt.id,
			workerRegistrationId: options.workerRegistrationId,
			workerId: options.workerId,
			failureKind: "process",
			detail,
			targetState: "DEVELOPMENT_FAILED",
			transitionOwner: "worker",
			now: now(),
		});
		emit({ type: "job_fail", durationMs: durationMs() });
		log?.error("development attempt process failure", {
			adapter: "autopilot",
			detail,
		});
		return {
			kind: "failed",
			attemptId: attempt.id,
			reason: mapFailure({ kind: "process", detail }).summary,
		};
	}
}
