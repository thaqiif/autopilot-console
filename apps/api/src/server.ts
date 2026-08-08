/**
 * Server factory (requirement 21).
 * Builds the Hono API app and serves it. Kept thin so the app boundary stays
 * testable without a live listener.
 */

import { serve } from "bun";
import { type ApiAppOptions, createApiApp } from "./app";

export interface ServerHandle {
	app: ReturnType<typeof createApiApp>["app"];
	stop: () => void;
}

export function createServer(options: ApiAppOptions & { port?: number }): ServerHandle {
	const { app } = createApiApp(options);
	const port = options.port ?? 3000;
	const server = serve({ fetch: app.fetch, port });
	return {
		app,
		stop: () => server.stop(true),
	};
}
