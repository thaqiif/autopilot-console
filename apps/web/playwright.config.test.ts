import { describe, expect, test } from "bun:test";

import { createPlaywrightServerConfig } from "./playwright.config";

describe("Playwright server isolation", () => {
	test("uses a qualification-owned strict port and never reuses an arbitrary server", () => {
		const config = createPlaywrightServerConfig({ PLAYWRIGHT_PORT: "43173" });

		expect(config.baseURL).toBe("http://127.0.0.1:43173");
		expect(config.webServer).toEqual({
			command: "bun run dev -- --host 127.0.0.1 --port 43173 --strictPort",
			url: "http://127.0.0.1:43173",
			reuseExistingServer: false,
			timeout: 30_000,
		});
	});

	test("rejects invalid ports before Playwright starts", () => {
		expect(() => createPlaywrightServerConfig({ PLAYWRIGHT_PORT: "5173; echo unsafe" })).toThrow(
			/PLAYWRIGHT_PORT/,
		);
		expect(() => createPlaywrightServerConfig({ PLAYWRIGHT_PORT: "70000" })).toThrow(
			/PLAYWRIGHT_PORT/,
		);
	});
});
