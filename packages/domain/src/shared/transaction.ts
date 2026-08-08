/**
 * Shared transaction and uniqueness helpers for domain mutation services.
 */

import type { Queryable, TransactionSql } from "../../../database/src/client";

type TxCapable = Queryable & {
	begin?: <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;
};

export async function withTransaction<T>(
	sql: Queryable,
	fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
	const capable = sql as TxCapable;
	if (typeof capable.begin === "function") {
		return capable.begin((tx) => fn(tx));
	}
	return fn(sql);
}

export function isUniqueViolation(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: string; message?: string };
	return e.code === "23505" || /unique|duplicate/i.test(e.message ?? "");
}
