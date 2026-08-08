import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const chromiumExecutable = [
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	"/opt/ms-playwright/chromium-1228/chrome-linux64/chrome",
	"/home/agent/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
	"/usr/bin/google-chrome",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

export function createPlaywrightServerConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	const rawPort = env.PLAYWRIGHT_PORT ?? "4173";
	const port = Number(rawPort);
	if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1024 || port > 65_535) {
		throw new Error(
			`PLAYWRIGHT_PORT must be an integer between 1024 and 65535; received ${rawPort}`,
		);
	}
	const baseURL = `http://127.0.0.1:${port}`;
	return {
		baseURL,
		webServer: {
			command: `bun run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
			url: baseURL,
			reuseExistingServer: false,
			timeout: 30_000,
		},
	};
}

const server = createPlaywrightServerConfig();

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI || process.env.PHASE1_QUALIFICATION ? 2 : 0,
	workers: process.env.CI || process.env.PHASE1_QUALIFICATION ? 1 : undefined,
	reporter: "list",
	use: {
		baseURL: server.baseURL,
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
	webServer: server.webServer,
});
