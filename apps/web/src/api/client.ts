import { createOperationKey, type OperationKeyParts } from "@autopilot-console/shared";
import type { ApiResponse } from "@autopilot-console/shared/contracts/api";

export interface ApiClientOptions {
	baseUrl: string;
	fetchOverride?: (...args: Parameters<typeof fetch>) => Promise<Response>;
	getCsrfToken?: () => string;
	onUnauthorized?: () => void;
}

export interface MutationOptions {
	/** Stable backend idempotency/operation key merged into the JSON body. */
	operationKey?: string;
	/** Alias accepted by some project-create paths. */
	idempotencyKey?: string;
}

export interface ApiClient {
	get<T = unknown>(path: string): Promise<ApiResponse<T>>;
	post<T = unknown>(
		path: string,
		body?: unknown,
		options?: MutationOptions,
	): Promise<ApiResponse<T>>;
	put<T = unknown>(
		path: string,
		body?: unknown,
		options?: MutationOptions,
	): Promise<ApiResponse<T>>;
	del<T = unknown>(path: string, options?: MutationOptions): Promise<ApiResponse<T>>;
	buildRequestInit(method?: string): RequestInit;
	setCsrfToken(token: string | null): void;
	setUnauthorizedHandler(handler: (() => void) | null): void;
	generateOperationKey(parts: OperationKeyParts): string;
}

function generateCorrelationId(): string {
	return crypto.randomUUID();
}

function mergeMutationBody(body: unknown, options?: MutationOptions): unknown {
	if (!options?.operationKey && !options?.idempotencyKey) {
		return body;
	}
	const base =
		body && typeof body === "object" && !Array.isArray(body)
			? { ...(body as Record<string, unknown>) }
			: {};
	if (options.operationKey) base.operationKey = options.operationKey;
	if (options.idempotencyKey) base.idempotencyKey = options.idempotencyKey;
	return base;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
	const { baseUrl, fetchOverride } = options;
	const fetchFn = fetchOverride;
	let csrfToken: string | null = null;
	let unauthorizedHandler = options.onUnauthorized ?? null;

	function getCsrfToken(): string | null {
		if (options.getCsrfToken) return options.getCsrfToken();
		return csrfToken;
	}

	async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
		const url = `${baseUrl}${path}`;
		const init = buildRequestInit(method);
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		try {
			const response = await (fetchFn ?? fetch)(url, init);
			if (response.status === 401) {
				csrfToken = null;
				unauthorizedHandler?.();
				return {
					ok: false,
					error: {
						code: "UNAUTHORIZED",
						message: "Session expired or invalid",
						httpStatus: 401,
						nextAction: "LOGIN",
					},
				};
			}
			const data = (await response.json()) as ApiResponse<T>;
			return data;
		} catch {
			return {
				ok: false,
				error: {
					code: "UNAVAILABLE",
					message: "Unable to reach server",
					httpStatus: 0,
					nextAction: "RETRY",
				},
			};
		}
	}

	function buildRequestInit(method = "GET"): RequestInit {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-correlation-id": generateCorrelationId(),
		};

		if (method !== "GET" && method !== "HEAD") {
			const token = getCsrfToken();
			if (token) headers["x-csrf-token"] = token;
		}

		return {
			method,
			headers,
			credentials: "include",
		};
	}

	return {
		get: <T>(path: string) => request<T>("GET", path),
		post: <T>(path: string, body?: unknown, mutationOptions?: MutationOptions) =>
			request<T>("POST", path, mergeMutationBody(body, mutationOptions)),
		put: <T>(path: string, body?: unknown, mutationOptions?: MutationOptions) =>
			request<T>("PUT", path, mergeMutationBody(body, mutationOptions)),
		del: <T>(path: string, mutationOptions?: MutationOptions) =>
			request<T>("DELETE", path, mergeMutationBody(undefined, mutationOptions)),
		buildRequestInit,
		setCsrfToken(token) {
			csrfToken = token;
		},
		setUnauthorizedHandler(handler) {
			unauthorizedHandler = handler;
		},
		generateOperationKey(parts) {
			return createOperationKey(parts);
		},
	};
}
