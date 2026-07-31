import { describe, expect, test } from "bun:test";
import { elapsedMsBetween, formatElapsedMs } from "./elapsed";

describe("formatElapsedMs", () => {
	test("formats seconds under one minute", () => {
		expect(formatElapsedMs(45_000)).toBe("45s");
	});

	test("formats minutes and remaining seconds", () => {
		expect(formatElapsedMs(120_000)).toBe("2 min 0s");
		expect(formatElapsedMs(125_000)).toBe("2 min 5s");
	});

	test("formats hours and remaining minutes", () => {
		expect(formatElapsedMs(3_600_000)).toBe("1h 0m");
		expect(formatElapsedMs(3_900_000)).toBe("1h 5m");
	});
});

describe("elapsedMsBetween", () => {
	test("computes duration with a fixed end clock", () => {
		const start = "2026-07-17T10:10:03Z";
		const end = "2026-07-17T10:12:03Z";
		expect(elapsedMsBetween(start, end)).toBe(120_000);
	});

	test("uses injectable now when end is omitted", () => {
		const start = "2026-07-17T10:10:03Z";
		const nowMs = new Date("2026-07-17T10:12:03Z").getTime();
		expect(elapsedMsBetween(start, null, nowMs)).toBe(120_000);
	});

	test("returns undefined for missing or inverted ranges", () => {
		expect(elapsedMsBetween(null)).toBeUndefined();
		expect(elapsedMsBetween("2026-07-17T10:12:03Z", "2026-07-17T10:10:03Z")).toBeUndefined();
	});
});
