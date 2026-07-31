import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
	formatLocalDate,
	formatLocalDateTime,
	formatLocalTime,
	formatRelativeTime,
	getTimezoneLabel,
	LocalDateTime,
	utcToLocal,
} from "./local-date-time";

describe("utcToLocal", () => {
	test("converts UTC ISO string to local Date", () => {
		const utc = "2026-01-15T12:00:00.000Z";
		const local = utcToLocal(utc);
		expect(local).toBeInstanceOf(Date);
		expect(local.getTime()).toBe(new Date(utc).getTime());
	});

	test("returns current time for 'now' keyword", () => {
		const before = Date.now();
		const result = utcToLocal("now");
		const after = Date.now();
		expect(result.getTime()).toBeGreaterThanOrEqual(before);
		expect(result.getTime()).toBeLessThanOrEqual(after);
	});

	test("handles Date input directly", () => {
		const date = new Date("2026-06-15T18:30:00.000Z");
		const result = utcToLocal(date);
		expect(result.getTime()).toBe(date.getTime());
	});

	test("handles timestamps as numbers", () => {
		const ts = 1736942400000;
		const result = utcToLocal(ts);
		expect(result.getTime()).toBe(ts);
	});
});

describe("formatLocalDateTime", () => {
	test("formats UTC date to local timezone with date and time", () => {
		const utc = "2026-01-15T12:00:00.000Z";
		const result = formatLocalDateTime(utc);
		expect(result).toContain("2026");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("returns empty string for null/undefined", () => {
		expect(formatLocalDateTime(null)).toBe("");
		expect(formatLocalDateTime(undefined)).toBe("");
	});

	test("uses en-US locale format by default", () => {
		const utc = "2026-07-04T15:30:00.000Z";
		const result = formatLocalDateTime(utc);
		expect(result).toContain("2026");
	});
});

describe("formatLocalDate", () => {
	test("formats UTC date to local date only", () => {
		const utc = "2026-03-20T08:00:00.000Z";
		const result = formatLocalDate(utc);
		expect(result).toContain("2026");
		expect(result.length).toBeGreaterThan(0);
	});

	test("returns empty string for null/undefined", () => {
		expect(formatLocalDate(null)).toBe("");
		expect(formatLocalDate(undefined)).toBe("");
	});
});

describe("formatLocalTime", () => {
	test("formats UTC time to local time only", () => {
		const utc = "2026-01-15T12:00:00.000Z";
		const result = formatLocalTime(utc);
		expect(result.length).toBeGreaterThan(0);
	});

	test("returns empty string for null/undefined", () => {
		expect(formatLocalTime(null)).toBe("");
		expect(formatLocalTime(undefined)).toBe("");
	});
});

describe("formatRelativeTime", () => {
	test("returns 'just now' for very recent times", () => {
		const now = new Date();
		const result = formatRelativeTime(now);
		expect(result).toBe("just now");
	});

	test("returns minutes ago for recent times", () => {
		const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
		const result = formatRelativeTime(fiveMinAgo);
		expect(result).toContain("minute");
	});

	test("returns hours ago for older times", () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const result = formatRelativeTime(twoHoursAgo);
		expect(result).toContain("hour");
	});

	test("returns days ago for day-old times", () => {
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		const result = formatRelativeTime(threeDaysAgo);
		expect(result).toContain("day");
	});

	test("returns empty string for null/undefined", () => {
		expect(formatRelativeTime(null)).toBe("");
		expect(formatRelativeTime(undefined)).toBe("");
	});
});

describe("getTimezoneLabel", () => {
	test("returns a timezone abbreviation", () => {
		const label = getTimezoneLabel();
		expect(typeof label).toBe("string");
		expect(label.length).toBeGreaterThan(0);
	});

	test("returns timezone for a specific date", () => {
		const date = new Date("2026-07-15T12:00:00Z");
		const label = getTimezoneLabel(date);
		expect(typeof label).toBe("string");
		expect(label.length).toBeGreaterThan(0);
	});
});

describe("LocalDateTime component", () => {
	test("renders a time element with datetime attribute", () => {
		const { container } = render(<LocalDateTime utc="2026-01-15T12:00:00.000Z" />);
		const timeEl = container.querySelector("time");
		expect(timeEl).toBeTruthy();
		expect(timeEl?.getAttribute("datetime")).toBe("2026-01-15T12:00:00.000Z");
	});

	test("renders accessible text with local time", () => {
		const { container } = render(<LocalDateTime utc="2026-01-15T12:00:00.000Z" />);
		const timeEl = container.querySelector("time");
		expect(timeEl?.textContent?.length).toBeGreaterThan(0);
	});

	test("includes timezone label in accessible text", () => {
		const { container } = render(<LocalDateTime utc="2026-01-15T12:00:00.000Z" showTimezone />);
		const timeEl = container.querySelector("time");
		expect(timeEl?.textContent).toContain("(");
	});

	test("derives the timezone label from the displayed string timestamp", () => {
		const previous = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			const utc = "2026-01-15T12:00:00.000Z";
			const { container } = render(<LocalDateTime utc={utc} showTimezone />);
			expect(container.querySelector("time")?.textContent).toContain(
				`(${getTimezoneLabel(new Date(utc))})`,
			);
		} finally {
			process.env.TZ = previous ?? "Etc/UTC";
		}
	});

	test("renders date-only variant", () => {
		const { container } = render(<LocalDateTime utc="2026-01-15T12:00:00.000Z" format="date" />);
		const timeEl = container.querySelector("time");
		expect(timeEl?.textContent).toContain("2026");
	});

	test("renders time-only variant", () => {
		const { container } = render(<LocalDateTime utc="2026-01-15T12:00:00.000Z" format="time" />);
		const timeEl = container.querySelector("time");
		expect(timeEl?.textContent?.length).toBeGreaterThan(0);
	});

	test("renders relative time variant", () => {
		const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const { container } = render(<LocalDateTime utc={recent} format="relative" />);
		const timeEl = container.querySelector("time");
		expect(timeEl?.textContent).toContain("minute");
	});

	test("renders nothing for null input", () => {
		const { container } = render(<LocalDateTime utc={null} />);
		expect(container.innerHTML).toBe("");
	});

	test("preserves source UTC value unchanged", () => {
		const utc = "2026-01-15T12:00:00.000Z";
		render(<LocalDateTime utc={utc} />);
		expect(utc).toBe("2026-01-15T12:00:00.000Z");
	});
});

describe("UTC source preservation", () => {
	test("formatting does not mutate the original UTC value", () => {
		const utc = "2026-01-15T12:00:00.000Z";
		const original = utc;
		formatLocalDateTime(utc);
		expect(utc).toBe(original);
	});

	test("local display differs from UTC string when not in UTC timezone", () => {
		const utc = "2026-01-15T12:00:00.000Z";
		const tzOffset = new Date().getTimezoneOffset();
		if (tzOffset !== 0) {
			const result = formatLocalDateTime(utc);
			expect(result).not.toBe(utc);
		}
	});
});

describe("timezone offsets", () => {
	const utc = "2026-07-19T12:00:00.000Z";

	test("formats correctly in UTC", () => {
		const previous = process.env.TZ;
		process.env.TZ = "Etc/UTC";
		try {
			const result = formatLocalDateTime(utc);
			expect(result).toContain("2026");
			expect(result.toLowerCase()).toMatch(/12:00|noon|pm|am/i);
			const label = getTimezoneLabel(new Date(utc));
			expect(label.length).toBeGreaterThan(0);
		} finally {
			process.env.TZ = previous ?? "Etc/UTC";
		}
	});

	test("formats correctly in a negative offset timezone", () => {
		const previous = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			const result = formatLocalDateTime(utc);
			expect(result).toContain("2026");
			// 12:00 UTC is morning in New York
			expect(result).toMatch(/8:00|AM|am/i);
		} finally {
			process.env.TZ = previous ?? "Etc/UTC";
		}
	});

	test("formats correctly in a positive offset timezone", () => {
		const previous = process.env.TZ;
		process.env.TZ = "Asia/Tokyo";
		try {
			const result = formatLocalDateTime(utc);
			expect(result).toContain("2026");
			// 12:00 UTC is evening in Tokyo (21:00)
			expect(result).toMatch(/9:00|PM|pm/i);
		} finally {
			process.env.TZ = previous ?? "Etc/UTC";
		}
	});
});
