/**
 * Shared Hono type augmentation for the API boundary (requirement 21).
 * Centralizes the request-scoped variables injected by middleware so
 * c.set/c.get are strongly typed across routes and handlers.
 */

export interface ApiVars {
	correlationId: string;
	adminId: string;
	adminUsername: string;
}

declare module "hono" {
	interface ContextVariableMap extends ApiVars {}
}
