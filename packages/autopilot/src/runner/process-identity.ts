/**
 * OS process identity: PID + start time for PID-reuse detection.
 */

export interface ProcessIdentity {
	pid: number;
	/** Process start time in milliseconds since epoch (or boot-relative converted). */
	startTimeMs: number;
}

export async function createProcessIdentity(_pid: number): Promise<ProcessIdentity> {
	throw new Error("not implemented: createProcessIdentity");
}

export async function verifyProcessIdentity(
	_identity: ProcessIdentity,
): Promise<boolean> {
	throw new Error("not implemented: verifyProcessIdentity");
}
