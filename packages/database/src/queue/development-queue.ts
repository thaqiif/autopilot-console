import type { Queryable } from "../client";
import type { WorkerRegistrationRow, DevelopmentAttemptRow } from "../repositories/workflow-repositories";

export interface DevelopmentQueueOptions {
	maxConcurrent?: number;
	leaseDurationMs?: number;
	clock?: () => Date;
}

export interface ClaimAttemptResult {
	attempt: DevelopmentAttemptRow;
	worker: WorkerRegistrationRow;
}

export interface DevelopmentQueue {
	claimNextAttempt(workerId: string): Promise<ClaimAttemptResult | null>;
}

/** Stub — will be implemented in the Green phase. */
export function createDevelopmentQueue(
	_sql: Queryable,
	_options?: DevelopmentQueueOptions,
): DevelopmentQueue {
	return {
		async claimNextAttempt(_workerId: string): Promise<ClaimAttemptResult | null> {
			throw new Error("not implemented");
		},
	};
}
