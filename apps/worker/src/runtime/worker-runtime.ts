import type {
	DevelopmentWorker,
	DevelopmentWorkerOutcome,
} from "../development/development-worker";

export type WorkerRuntimeOutcome = DevelopmentWorkerOutcome;

export type SlotStartResult =
	| { kind: "idle" }
	| {
			kind: "started";
			attemptId: string;
			finished: Promise<WorkerRuntimeOutcome>;
	  };

export interface WorkerRuntime {
	run(signal: AbortSignal): Promise<void>;
	activeCount(): number;
	capacity(): number;
}

export interface WorkerRuntimeOptions {
	/** Maximum number of concurrent in-flight jobs this process may own. */
	capacity: number;
	/**
	 * Attempt to start one more job. Returns idle when no eligible work is
	 * available. Must not block on job completion; return a finished promise.
	 */
	startSlot: () => Promise<SlotStartResult>;
	/** Persist registration heartbeat with the current active-job count. */
	heartbeat: (activeJobs: number) => Promise<void>;
	/** Optional metrics/readiness callback when active count changes. */
	onActiveJobsChange?: (activeJobs: number) => void;
	heartbeatIntervalMs?: number;
	idlePollMs?: number;
	/**
	 * Optional sleep helper. Must resolve early when the abort signal fires.
	 * Defaults to a timer that is cleared on abort.
	 */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ConcurrentDevelopmentWorkerRuntimeOptions {
	capacity: number;
	worker: DevelopmentWorker;
	heartbeat: (activeJobs: number) => Promise<void>;
	onActiveJobsChange?: (activeJobs: number) => void;
	heartbeatIntervalMs?: number;
	idlePollMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Bounded concurrent supervisor for production worker ownership.
 *
 * Claims fill free capacity without awaiting job completion. Active count is
 * reported on every start/finish and on periodic registration heartbeats so
 * readiness can expose actual ownership and available slots.
 */
export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
	const capacity = Math.max(1, Math.floor(options.capacity));
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
	const idlePollMs = options.idlePollMs ?? 1_000;
	const sleep = options.sleep ?? defaultSleep;

	let active = 0;
	const activeByAttempt = new Map<string, Promise<WorkerRuntimeOutcome>>();

	function publishActive(): void {
		options.onActiveJobsChange?.(active);
		// Persist registration counts as ownership changes so readiness never
		// lags behind claim/release until the next interval tick.
		void options.heartbeat(active).catch(() => undefined);
	}

	function track(attemptId: string, finished: Promise<WorkerRuntimeOutcome>): void {
		active += 1;
		publishActive();
		const tracked = finished.finally(() => {
			activeByAttempt.delete(attemptId);
			active = Math.max(0, active - 1);
			publishActive();
		});
		activeByAttempt.set(attemptId, tracked);
		// Ensure rejections never become unhandled; the supervisor only needs lifecycle.
		void tracked.catch(() => undefined);
	}

	async function fillSlots(): Promise<"started" | "idle" | "full"> {
		if (active >= capacity) return "full";
		let startedAny = false;
		while (active < capacity) {
			const result = await options.startSlot();
			if (result.kind === "idle") {
				return startedAny ? "started" : "idle";
			}
			track(result.attemptId, result.finished);
			startedAny = true;
		}
		return startedAny ? "started" : "full";
	}

	async function run(signal: AbortSignal): Promise<void> {
		// Immediate heartbeat so readiness sees capacity before the first claim.
		await options.heartbeat(active);
		let lastHeartbeat = Date.now();
		publishActive();

		while (!signal.aborted) {
			if (Date.now() - lastHeartbeat >= heartbeatIntervalMs) {
				await options.heartbeat(active);
				lastHeartbeat = Date.now();
			}

			const fill = await fillSlots();
			if (signal.aborted) break;
			// Idle/full: wait before re-polling. Started: loop immediately to fill remaining slots.
			if (fill !== "started") {
				await sleep(idlePollMs, signal);
			}
		}

		// Deterministic shutdown: drain in-flight ownership before returning.
		if (activeByAttempt.size > 0) {
			await Promise.allSettled([...activeByAttempt.values()]);
		}
		await options.heartbeat(active);
	}

	return {
		run,
		activeCount: () => active,
		capacity: () => capacity,
	};
}

/**
 * Compose a DevelopmentWorker into a concurrent production supervisor.
 * Each free slot calls beginOnce so Autopilot waits overlap across projects.
 */
export function createConcurrentDevelopmentWorkerRuntime(
	options: ConcurrentDevelopmentWorkerRuntimeOptions,
): WorkerRuntime {
	return createWorkerRuntime({
		capacity: options.capacity,
		heartbeat: options.heartbeat,
		onActiveJobsChange: options.onActiveJobsChange,
		heartbeatIntervalMs: options.heartbeatIntervalMs,
		idlePollMs: options.idlePollMs,
		sleep: options.sleep,
		startSlot: () => options.worker.beginOnce(),
	});
}
