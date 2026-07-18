import type { Queryable } from "../client";

export interface LeaseReconcilerOptions {
	clock?: () => Date;
}

export interface LeaseReconciler {
	interruptExpiredLeases(): Promise<number>;
}

/** Stub — will be implemented in the Green phase. */
export function createLeaseReconciler(
	_sql: Queryable,
	_options?: LeaseReconcilerOptions,
): LeaseReconciler {
	return {
		async interruptExpiredLeases(): Promise<number> {
			throw new Error("not implemented");
		},
	};
}
