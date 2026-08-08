import { afterEach, describe, expect, test } from "bun:test";
import { createWorkerHealthServer, type WorkerHealthServer } from "./worker-health-server";

describe("createWorkerHealthServer", () => {
	let server: WorkerHealthServer | undefined;

	afterEach(() => {
		server?.stop();
		server = undefined;
	});

	test("answers /health/live with 200 when ready", async () => {
		server = createWorkerHealthServer({ port: 0, hostname: "127.0.0.1" });
		const response = await fetch(`http://127.0.0.1:${server.port}/health/live`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; data: { status: string } };
		expect(body.ok).toBe(true);
		expect(body.data.status).toBe("live");
	});

	test("returns 503 when readiness reports not ready", async () => {
		server = createWorkerHealthServer({
			port: 0,
			hostname: "127.0.0.1",
			isReady: () => false,
		});
		const response = await fetch(`http://127.0.0.1:${server.port}/health/live`);
		expect(response.status).toBe(503);
	});

	test("returns 404 for unknown paths", async () => {
		server = createWorkerHealthServer({ port: 0, hostname: "127.0.0.1" });
		const response = await fetch(`http://127.0.0.1:${server.port}/`);
		expect(response.status).toBe(404);
	});

	test("honors WORKER_HEALTH_PORT when options.port is omitted", async () => {
		const previous = process.env.WORKER_HEALTH_PORT;
		process.env.WORKER_HEALTH_PORT = "0";
		try {
			server = createWorkerHealthServer({ hostname: "127.0.0.1" });
			const response = await fetch(`http://127.0.0.1:${server.port}/health/live`);
			expect(response.status).toBe(200);
		} finally {
			if (previous === undefined) delete process.env.WORKER_HEALTH_PORT;
			else process.env.WORKER_HEALTH_PORT = previous;
		}
	});
});
