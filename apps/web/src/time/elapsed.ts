/**
 * Deterministic elapsed-duration helpers for job progress views.
 * Prefer these over ad-hoc Date arithmetic so fake-clock tests stay stable.
 */

export function elapsedMsBetween(
	startTime: string | number | Date | null | undefined,
	endTime?: string | number | Date | null,
	nowMs: number = Date.now(),
): number | undefined {
	if (startTime === null || startTime === undefined) return undefined;
	const start = startTime instanceof Date ? startTime.getTime() : new Date(startTime).getTime();
	if (Number.isNaN(start)) return undefined;
	const end =
		endTime === null || endTime === undefined
			? nowMs
			: endTime instanceof Date
				? endTime.getTime()
				: new Date(endTime).getTime();
	if (Number.isNaN(end) || end < start) return undefined;
	return end - start;
}

export function formatElapsedMs(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes} min ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
