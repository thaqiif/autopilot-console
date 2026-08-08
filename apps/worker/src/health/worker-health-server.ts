/**
 * Minimal internal health HTTP server for Compose probes.
 * Bound only inside the container; Compose does not publish the port.
 */

export const DEFAULT_WORKER_HEALTH_PORT = 3001;
export const WORKER_HEALTH_LIVE_PATH = "/health/live";

export interface WorkerHealthServer {
	port: number;
	stop: () => void;
}

export interface WorkerHealthServerOptions {
	/** Defaults to WORKER_HEALTH_PORT or {@link DEFAULT_WORKER_HEALTH_PORT}. */
	port?: number;
	/** Hostname to bind; defaults to 127.0.0.1 so the probe stays local. */
	hostname?: string;
	/** Optional readiness callback. When provided and returns false, live probe is 503. */
	isReady?: () => boolean | Promise<boolean>;
}

function resolvePort(optionsPort: number | undefined): number {
	if (typeof optionsPort === "number" && Number.isFinite(optionsPort)) {
		return optionsPort;
	}
	const fromEnv = Number(process.env.WORKER_HEALTH_PORT);
	if (Number.isFinite(fromEnv) && fromEnv > 0) {
		return fromEnv;
	}
	return DEFAULT_WORKER_HEALTH_PORT;
}

export function createWorkerHealthServer(
	options: WorkerHealthServerOptions = {},
): WorkerHealthServer {
	const port = resolvePort(options.port);
	const hostname = options.hostname ?? "127.0.0.1";
	const isReady = options.isReady ?? (() => true);

	const server = Bun.serve({
		port,
		hostname,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === WORKER_HEALTH_LIVE_PATH || url.pathname === "/health/ready") {
				const ready = await isReady();
				if (!ready) {
					return Response.json({ ok: false, data: { status: "not_ready" } }, { status: 503 });
				}
				return Response.json({
					ok: true,
					data: { status: "live", checkedAt: new Date().toISOString() },
				});
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	return {
		port: server.port ?? port,
		stop: () => {
			server.stop(true);
		},
	};
}
