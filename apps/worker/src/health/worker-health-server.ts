/**
 * Minimal internal health HTTP server for Compose probes.
 * Bound only inside the container; Compose does not publish the port.
 */

export interface WorkerHealthServer {
	port: number;
	stop: () => void;
}

export interface WorkerHealthServerOptions {
	/** Defaults to WORKER_HEALTH_PORT or 3001. */
	port?: number;
	/** Hostname to bind; defaults to 127.0.0.1 so the probe stays local. */
	hostname?: string;
	/** Optional readiness callback. When provided and returns false, /health/live is 503. */
	isReady?: () => boolean | Promise<boolean>;
}

export function createWorkerHealthServer(
	options: WorkerHealthServerOptions = {},
): WorkerHealthServer {
	const port = options.port ?? (Number(process.env.WORKER_HEALTH_PORT) || 3001);
	const hostname = options.hostname ?? "127.0.0.1";
	const isReady = options.isReady ?? (() => true);

	const server = Bun.serve({
		port,
		hostname,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/health/live" || url.pathname === "/health/ready") {
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
