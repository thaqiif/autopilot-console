import type { Queryable } from "../../../../packages/database/src/index";
import { createIdempotencyRecord } from "../../../../packages/database/src/index";
import { createNormalizedError } from "../../../../packages/shared/src/index";

interface StoredMutation<T> {
	namespace: string;
	data: T;
}

export interface MutationScope {
	projectId: string;
	featureId?: string;
	attemptId?: string;
}

export interface IdempotentMutationOptions<T> {
	operationKey?: string;
	namespace: string;
	correlationId: string;
	run: () => Promise<T>;
	scope: (data: T) => MutationScope;
}

export interface MutationIdempotency {
	execute<T>(options: IdempotentMutationOptions<T>): Promise<{ data: T; idempotent: boolean }>;
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "23505"
	);
}

export function createMutationIdempotency(sql: Queryable): MutationIdempotency {
	const inFlight = new Map<string, Promise<{ data: unknown; idempotent: boolean }>>();

	async function load<T>(
		operationKey: string,
		namespace: string,
		correlationId: string,
	): Promise<T | undefined> {
		const [row] = await sql`
			SELECT result FROM idempotency_records WHERE operation_key = ${operationKey}
		`;
		if (!row) return undefined;
		const stored = row.result as Partial<StoredMutation<T>>;
		if (stored.namespace !== namespace || !("data" in stored)) {
			throw createNormalizedError({
				code: "IDEMPOTENCY_CONFLICT",
				message: "Operation key was already used for a different mutation.",
				httpStatus: 409,
				correlationId,
			});
		}
		return stored.data as T;
	}

	return {
		async execute<T>(
			options: IdempotentMutationOptions<T>,
		): Promise<{ data: T; idempotent: boolean }> {
			const key = options.operationKey?.trim();
			if (!key) return { data: await options.run(), idempotent: false };

			const cached = await load<T>(key, options.namespace, options.correlationId);
			if (cached !== undefined) return { data: cached, idempotent: true };

			const active = inFlight.get(key);
			if (active) {
				const result = await active;
				return { data: result.data as T, idempotent: true };
			}

			const operation = (async () => {
				const rechecked = await load<T>(key, options.namespace, options.correlationId);
				if (rechecked !== undefined) return { data: rechecked, idempotent: true };

				const data = await options.run();
				const scope = options.scope(data);
				try {
					await createIdempotencyRecord(sql, {
						operationKey: key,
						...scope,
						result: { namespace: options.namespace, data } satisfies StoredMutation<T>,
					});
					return { data, idempotent: false };
				} catch (error) {
					if (!isUniqueViolation(error)) throw error;
					const winner = await load<T>(key, options.namespace, options.correlationId);
					if (winner === undefined) throw error;
					return { data: winner, idempotent: true };
				}
			})();

			inFlight.set(key, operation as Promise<{ data: unknown; idempotent: boolean }>);
			try {
				return await operation;
			} finally {
				inFlight.delete(key);
			}
		},
	};
}
