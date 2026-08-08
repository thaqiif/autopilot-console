/** Shared production health status formatting for Settings (and reusable UI). */

export type ComponentStatus = "ok" | "degraded" | "down";

/** Accessible status token: text + data-status, never color alone. */
export type AccessibleStatus = "healthy" | "degraded" | "unavailable";

export function toAccessibleStatus(status: ComponentStatus | undefined): AccessibleStatus {
	if (status === "ok") return "healthy";
	if (status === "degraded") return "degraded";
	return "unavailable";
}

export function formatMetric(value: unknown): string {
	if (value === undefined || value === null || value === "") return "unavailable";
	if (typeof value === "number" && !Number.isFinite(value)) return "unavailable";
	return String(value);
}
