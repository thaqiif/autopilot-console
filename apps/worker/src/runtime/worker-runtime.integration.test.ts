/**
 * Production worker runtime concurrency (requirement 36).
 *
 * Controllable slot starts prove a single production supervisor can own four
 * different-project jobs concurrently, leave a fifth queued until capacity
 * frees, enforce same-project exclusion, report accurate active-job heartbeats,
 * and keep processing after a job failure.
 */
import { describe, expect, test } from "bun:test";
import {
	createWorkerRuntime,
	type SlotStartResult,
	type WorkerRuntimeOutcome,
} from "./worker-runtime";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function waitFor(
	predicate: () => boolean,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const pollMs = options.pollMs ?? 5;
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - started >= timeoutMs) {
				reject(new Error("waitFor timed out"));
				return;
			}
			setTimeout(tick, pollMs);
		};
		tick();
	});
}

interface ControllableJob {
	attemptId: string;
	projectId: string;
	release: (outcome?: WorkerRuntimeOutcome) => void;
	started: Promise<void>;
}

function createControllableSlotSource(jobs: Array<{ attemptId: string; projectId: string }>) {
	const pending = [...jobs];
	const activeProjects = new Set<string>();
	const started: ControllableJob[] = [];
	const completions: WorkerRuntimeOutcome[] = [];
	let concurrentPeak = 0;
	let inFlight = 0;

	async function startSlot(): Promise<SlotStartResult> {
		const index = pending.findIndex((job) => !activeProjects.has(job.projectId));
		if (index < 0) return { kind: "idle" };
		const [job] = pending.splice(index, 1);
		if (!job) return { kind: "idle" };

		activeProjects.add(job.projectId);
		inFlight += 1;
		concurrentPeak = Math.max(concurrentPeak, inFlight);

		const gate = deferred<WorkerRuntimeOutcome>();
		const startedGate = deferred<void>();
		const controllable: ControllableJob = {
			attemptId: job.attemptId,
			projectId: job.projectId,
			release: (outcome) => {
				gate.resolve(
					outcome ?? {
						kind: "completed",
						attemptId: job.attemptId,
					},
				);
			},
			started: startedGate.promise,
		};
		started.push(controllable);
		startedGate.resolve();

		const finished = gate.promise.finally(() => {
			activeProjects.delete(job.projectId);
			inFlight -= 1;
		});

		void finished.then((outcome) => {
			completions.push(outcome);
		});

		return {
			kind: "started",
			attemptId: job.attemptId,
			finished,
		};
	}

	return {
		startSlot,
		started,
		completions,
		get concurrentPeak() {
			return concurrentPeak;
		},
		get inFlight() {
			return inFlight;
		},
		get pendingCount() {
			return pending.length;
		},
	};
}

describe("production worker runtime concurrency", () => {
	test("owns four different-project jobs concurrently and leaves a fifth queued until a slot frees", async () => {
		const jobs = Array.from({ length: 5 }, (_, i) => ({
			attemptId: `attempt-${i + 1}`,
			projectId: `project-${i + 1}`,
		}));
		const source = createControllableSlotSource(jobs);
		const heartbeats: number[] = [];
		const activeSamples: number[] = [];
		const controller = new AbortController();

		const runtime = createWorkerRuntime({
			capacity: 4,
			startSlot: source.startSlot,
			heartbeat: async (activeJobs) => {
				heartbeats.push(activeJobs);
			},
			onActiveJobsChange: (activeJobs) => {
				activeSamples.push(activeJobs);
			},
			heartbeatIntervalMs: 20,
			idlePollMs: 10,
		});

		const running = runtime.run(controller.signal);

		await waitFor(() => source.started.length === 4);
		expect(runtime.activeCount()).toBe(4);
		expect(source.concurrentPeak).toBe(4);
		expect(source.pendingCount).toBe(1);
		expect(source.started.map((job) => job.attemptId).sort()).toEqual([
			"attempt-1",
			"attempt-2",
			"attempt-3",
			"attempt-4",
		]);
		await waitFor(() => heartbeats.some((count) => count === 4));
		expect(Math.max(0, ...activeSamples, ...heartbeats)).toBe(4);

		// Release one slot — the fifth job must start.
		source.started[0]?.release({ kind: "completed", attemptId: source.started[0].attemptId });
		await waitFor(() => source.started.length === 5);
		expect(source.started.map((job) => job.attemptId)).toContain("attempt-5");
		expect(source.pendingCount).toBe(0);

		for (const job of source.started) {
			job.release({ kind: "completed", attemptId: job.attemptId });
		}
		await waitFor(() => runtime.activeCount() === 0);
		controller.abort();
		await running;

		expect(source.completions).toHaveLength(5);
		expect(heartbeats.at(-1)).toBe(0);
	});

	test("never starts two attempts for the same project even when capacity remains", async () => {
		const jobs = [
			{ attemptId: "p1-a", projectId: "project-1" },
			{ attemptId: "p1-b", projectId: "project-1" },
			{ attemptId: "p2-a", projectId: "project-2" },
		];
		const source = createControllableSlotSource(jobs);
		const controller = new AbortController();
		const runtime = createWorkerRuntime({
			capacity: 4,
			startSlot: source.startSlot,
			heartbeat: async () => {},
			heartbeatIntervalMs: 50,
			idlePollMs: 10,
		});

		const running = runtime.run(controller.signal);
		await waitFor(() => source.started.length === 2);
		expect(source.started.map((job) => job.projectId).sort()).toEqual(["project-1", "project-2"]);
		expect(source.pendingCount).toBe(1);
		expect(runtime.activeCount()).toBe(2);

		// Same-project second attempt stays pending while the first owns the project.
		await Bun.sleep(30);
		expect(source.started.length).toBe(2);

		const first = source.started.find((job) => job.projectId === "project-1");
		first?.release({ kind: "completed", attemptId: first.attemptId });
		await waitFor(() => source.started.length === 3);
		expect(source.started.map((job) => job.attemptId).sort()).toEqual(["p1-a", "p1-b", "p2-a"]);

		for (const job of source.started) {
			job.release({ kind: "completed", attemptId: job.attemptId });
		}
		await waitFor(() => runtime.activeCount() === 0);
		controller.abort();
		await running;
	});

	test("reports rising and falling active-job counts on registration heartbeats", async () => {
		const jobs = [
			{ attemptId: "a1", projectId: "p1" },
			{ attemptId: "a2", projectId: "p2" },
		];
		const source = createControllableSlotSource(jobs);
		const heartbeats: number[] = [];
		const controller = new AbortController();
		const runtime = createWorkerRuntime({
			capacity: 4,
			startSlot: source.startSlot,
			heartbeat: async (activeJobs) => {
				heartbeats.push(activeJobs);
			},
			heartbeatIntervalMs: 15,
			idlePollMs: 10,
		});

		const running = runtime.run(controller.signal);
		await waitFor(() => source.started.length === 2 && heartbeats.includes(2));
		expect(runtime.capacity()).toBe(4);
		expect(runtime.activeCount()).toBe(2);

		source.started[0]?.release({ kind: "completed", attemptId: "a1" });
		await waitFor(() => heartbeats.includes(1));
		source.started[1]?.release({ kind: "completed", attemptId: "a2" });
		await waitFor(() => runtime.activeCount() === 0 && heartbeats.includes(0));
		controller.abort();
		await running;

		expect(heartbeats[0]).toBeGreaterThanOrEqual(0);
		expect(Math.max(...heartbeats)).toBe(2);
		expect(heartbeats.at(-1)).toBe(0);
	});

	test("continues claiming later eligible jobs after a failed run", async () => {
		// Capacity 1 forces serial ownership so the second claim only happens after
		// the failed run releases its slot — proving the supervisor does not stop.
		const jobs = [
			{ attemptId: "failing", projectId: "p-fail" },
			{ attemptId: "later", projectId: "p-later" },
		];
		const source = createControllableSlotSource(jobs);
		const controller = new AbortController();
		const runtime = createWorkerRuntime({
			capacity: 1,
			startSlot: source.startSlot,
			heartbeat: async () => {},
			heartbeatIntervalMs: 50,
			idlePollMs: 10,
		});

		const running = runtime.run(controller.signal);
		await waitFor(() => source.started.some((job) => job.attemptId === "failing"));
		expect(source.started.map((job) => job.attemptId)).toEqual(["failing"]);
		const failing = source.started.find((job) => job.attemptId === "failing");
		failing?.release({
			kind: "failed",
			attemptId: "failing",
			reason: "simulated process failure",
		});
		await waitFor(() => source.started.some((job) => job.attemptId === "later"));
		const later = source.started.find((job) => job.attemptId === "later");
		later?.release({ kind: "completed", attemptId: "later" });
		await waitFor(() => runtime.activeCount() === 0);
		controller.abort();
		await running;

		expect(source.completions).toEqual(
			expect.arrayContaining([
				{ kind: "failed", attemptId: "failing", reason: "simulated process failure" },
				{ kind: "completed", attemptId: "later" },
			]),
		);
	});
});
