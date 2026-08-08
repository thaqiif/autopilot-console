/**
 * Correlation id middleware.
 * Reads an inbound x-correlation-id (or mints a new one), stamps every
 * response with it, and exposes it to downstream handlers via c.var.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { createCorrelationId } from "../../../../packages/shared/src/index";

export const CORRELATION_HEADER = "x-correlation-id";

export interface CorrelationVars {
	correlationId: string;
}

export function correlationMiddleware(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const inbound = c.req.header(CORRELATION_HEADER);
		const correlationId =
			inbound && inbound.length > 0 ? inbound : createCorrelationId({ scope: "http" });
		c.set("correlationId", correlationId);
		c.header(CORRELATION_HEADER, correlationId);
		await next();
	};
}
