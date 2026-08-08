/**
 * Controllable fake `gh` executable runner for GitHubGateway unit tests.
 * Records argv and returns scripted JSON / errors — no real network.
 */

export interface FakeGhCall {
	argv: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export interface FakeGhResponse {
	status: number;
	stdout: string;
	stderr: string;
}

export type FakeGhHandler = (call: FakeGhCall) => FakeGhResponse;

export interface FakeGh {
	calls: FakeGhCall[];
	/** Default handler when no more scripted responses remain. */
	defaultResponse: FakeGhResponse;
	/** FIFO scripted responses (consumed in order). */
	queue: FakeGhResponse[];
	/** Optional per-call handler override (takes precedence over queue). */
	handler?: FakeGhHandler;
	run: (
		argv: readonly string[],
		options?: { cwd?: string; env?: Record<string, string | undefined> },
	) => FakeGhResponse;
	enqueue: (...responses: FakeGhResponse[]) => void;
	reset: () => void;
}

export function createFakeGh(initial?: Partial<FakeGh>): FakeGh {
	const state: FakeGh = {
		calls: [],
		defaultResponse: { status: 1, stdout: "", stderr: "fake-gh: no response queued" },
		queue: [],
		handler: undefined,
		run(argv, options) {
			const call: FakeGhCall = {
				argv: [...argv],
				cwd: options?.cwd,
				env: options?.env,
			};
			state.calls.push(call);
			if (state.handler) {
				return state.handler(call);
			}
			const next = state.queue.shift();
			return next ?? state.defaultResponse;
		},
		enqueue(...responses) {
			state.queue.push(...responses);
		},
		reset() {
			state.calls = [];
			state.queue = [];
			state.handler = undefined;
		},
		...initial,
	};
	return state;
}

export function jsonResponse(body: unknown, status = 0): FakeGhResponse {
	return { status, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
}

export function textResponse(stdout: string, status = 0, stderr = ""): FakeGhResponse {
	return { status, stdout, stderr };
}

export function errorResponse(stderr: string, status = 1): FakeGhResponse {
	return { status, stdout: "", stderr };
}
