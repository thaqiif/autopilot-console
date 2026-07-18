const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Format a Date as ISO-8601 UTC with millisecond precision and trailing Z. */
export function formatUtcIso(date: Date): string {
	if (Number.isNaN(date.getTime())) {
		throw new Error("Invalid date for UTC ISO formatting");
	}
	return date.toISOString();
}

/** True only for strict ISO-8601 UTC strings ending in Z (no offsets). */
export function isUtcIso(value: string): boolean {
	if (!UTC_ISO_RE.test(value)) return false;
	const parsed = Date.parse(value);
	return !Number.isNaN(parsed);
}

/** Parse a strict ISO-8601 UTC string; rejects offset and non-ISO forms. */
export function parseUtcIso(value: string): Date {
	if (!isUtcIso(value)) {
		throw new Error(`Invalid UTC ISO-8601 timestamp: ${value}`);
	}
	return new Date(value);
}

/** Current wall-clock as UTC ISO (injectable for tests via optional clock). */
export function nowUtcIso(now: () => Date = () => new Date()): string {
	return formatUtcIso(now());
}
