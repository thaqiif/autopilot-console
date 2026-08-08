export type UtcInput = string | Date | number | null | undefined;

export function utcToLocal(input: UtcInput): Date {
	if (input === null || input === undefined) return new Date();
	if (input === "now") return new Date();
	if (input instanceof Date) return input;
	if (typeof input === "number") return new Date(input);
	return new Date(input);
}

export function formatLocalDateTime(input: UtcInput): string {
	if (input === null || input === undefined) return "";
	const date = utcToLocal(input);
	return date.toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

export function formatLocalDate(input: UtcInput): string {
	if (input === null || input === undefined) return "";
	const date = utcToLocal(input);
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function formatLocalTime(input: UtcInput): string {
	if (input === null || input === undefined) return "";
	const date = utcToLocal(input);
	return date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

export function formatRelativeTime(input: UtcInput): string {
	if (input === null || input === undefined) return "";
	const date = utcToLocal(input);
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);

	if (diffSec < 60) return "just now";

	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;

	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;

	const diffDays = Math.floor(diffHr / 24);
	return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

export function getTimezoneLabel(date?: Date): string {
	const d = date ?? new Date();
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZoneName: "short",
	}).formatToParts(d);
	const tzPart = parts.find((p) => p.type === "timeZoneName");
	return tzPart?.value ?? "";
}

export interface LocalDateTimeProps {
	utc: UtcInput;
	format?: "datetime" | "date" | "time" | "relative";
	showTimezone?: boolean;
}

export function LocalDateTime({ utc, format = "datetime", showTimezone }: LocalDateTimeProps) {
	if (utc === null || utc === undefined) return null;

	let text: string;
	switch (format) {
		case "date":
			text = formatLocalDate(utc);
			break;
		case "time":
			text = formatLocalTime(utc);
			break;
		case "relative":
			text = formatRelativeTime(utc);
			break;
		default:
			text = formatLocalDateTime(utc);
	}

	if (showTimezone) {
		const tz = getTimezoneLabel(utcToLocal(utc));
		if (tz) text = `${text} (${tz})`;
	}

	const isoValue =
		typeof utc === "string"
			? utc
			: utc instanceof Date
				? utc.toISOString()
				: new Date(utc).toISOString();

	return <time dateTime={isoValue}>{text}</time>;
}
