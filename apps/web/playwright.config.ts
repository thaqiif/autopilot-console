import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const chromiumExecutable = [
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	"/opt/ms-playwright/chromium-1228/chrome-linux64/chrome",
	"/home/agent/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
	"/usr/bin/google-chrome",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "list",
	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
		launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : undefined,
	},
	projects: [
		{
			name: "desktop-chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "mobile-chromium",
			use: {
				...devices["Pixel 5"],
				viewport: { width: 375, height: 667 },
			},
		},
	],
	webServer: {
		command: "bun run dev",
		url: "http://localhost:5173",
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
});
