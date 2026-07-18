/**
 * Progress observer — captures task snapshots, derives activity,
 * writes bounded diagnostic logs, and supports paginated queries.
 * Stub: implementation pending.
 */
export interface ProgressObserver {
	snapshotTask(args: unknown): Promise<unknown>;
	deriveActivity(args: unknown): Promise<unknown>;
	appendDiagnostic(stream: string, body: string): Promise<unknown>;
	listActivity(opts?: unknown): Promise<unknown>;
	getLatestSnapshot(): Promise<unknown>;
	read(): unknown;
	readonly lastVersion: number;
}

export interface ProgressObserverOptions {
	projectId: string;
	featureId: string;
	attemptId: string;
	maxDiagnosticBytes?: number;
	now?: () => Date;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createProgressObserver(_store: unknown, _options: ProgressObserverOptions): ProgressObserver {
	throw new Error("Not implemented");
}
