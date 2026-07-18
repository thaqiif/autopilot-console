import { describe, expect, test } from "bun:test";
import {
	loadRuntimeConfig,
	type RuntimeConfig,
	safeSerializeConfig,
} from "./runtime-config.ts";

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		DATABASE_URL: "postgres://localhost:5432/autopilot",
		ADMIN_BOOTSTRAP_PASSWORD: "Str0ng-P@ssw0rd-Enough!",
		WORKSPACE_ROOTS: "/var/workspaces,/data/projects",
		SESSION_SECRET: "session-secret-at-least-32-chars-long!!",
		MAX_CONCURRENT_JOBS: "4",
		GITHUB_POLL_INTERVAL_SECONDS: "60",
		NODE_ENV: "development",
		...overrides,
	};
}

describe("loadRuntimeConfig", () => {
	test("accepts complete valid deployment configuration", () => {
		const config = loadRuntimeConfig(validEnv());
		expect(config.database.url).toBe("postgres://localhost:5432/autopilot");
		expect(config.admin.bootstrapPassword).toBe("Str0ng-P@ssw0rd-Enough!");
		expect(config.workspace.roots).toEqual(["/var/workspaces", "/data/projects"]);
		expect(config.worker.maxConcurrentJobs).toBe(4);
		expect(config.github.pollIntervalSeconds).toBe(60);
		expect(config.session.secret).toBe("session-secret-at-least-32-chars-long!!");
		expect(config.nodeEnv).toBe("development");
	});

	test("rejects missing database settings", () => {
		expect(() => loadRuntimeConfig(validEnv({ DATABASE_URL: undefined }))).toThrow(
			/database/i,
		);
		expect(() => loadRuntimeConfig(validEnv({ DATABASE_URL: "" }))).toThrow(/database/i);
		expect(() => loadRuntimeConfig(validEnv({ DATABASE_URL: "   " }))).toThrow(/database/i);
	});

	test("rejects missing session secret", () => {
		expect(() => loadRuntimeConfig(validEnv({ SESSION_SECRET: undefined }))).toThrow(
			/session/i,
		);
	});

	test("rejects empty workspace-root allowlists", () => {
		expect(() => loadRuntimeConfig(validEnv({ WORKSPACE_ROOTS: undefined }))).toThrow(
			/workspace/i,
		);
		expect(() => loadRuntimeConfig(validEnv({ WORKSPACE_ROOTS: "" }))).toThrow(/workspace/i);
		expect(() => loadRuntimeConfig(validEnv({ WORKSPACE_ROOTS: " , , " }))).toThrow(
			/workspace/i,
		);
	});

	test("rejects invalid concurrency limits", () => {
		expect(() => loadRuntimeConfig(validEnv({ MAX_CONCURRENT_JOBS: "0" }))).toThrow(
			/concurren/i,
		);
		expect(() => loadRuntimeConfig(validEnv({ MAX_CONCURRENT_JOBS: "-1" }))).toThrow(
			/concurren/i,
		);
		expect(() => loadRuntimeConfig(validEnv({ MAX_CONCURRENT_JOBS: "11" }))).toThrow(
			/concurren/i,
		);
		expect(() => loadRuntimeConfig(validEnv({ MAX_CONCURRENT_JOBS: "abc" }))).toThrow(
			/concurren/i,
		);
	});

	test("rejects invalid polling limits", () => {
		expect(() =>
			loadRuntimeConfig(validEnv({ GITHUB_POLL_INTERVAL_SECONDS: "0" })),
		).toThrow(/poll/i);
		expect(() =>
			loadRuntimeConfig(validEnv({ GITHUB_POLL_INTERVAL_SECONDS: "-5" })),
		).toThrow(/poll/i);
		expect(() =>
			loadRuntimeConfig(validEnv({ GITHUB_POLL_INTERVAL_SECONDS: "99999" })),
		).toThrow(/poll/i);
		expect(() =>
			loadRuntimeConfig(validEnv({ GITHUB_POLL_INTERVAL_SECONDS: "nope" })),
		).toThrow(/poll/i);
	});

	test("rejects weak bootstrap passwords", () => {
		expect(() =>
			loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: undefined })),
		).toThrow(/password/i);
		expect(() => loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: "" }))).toThrow(
			/password/i,
		);
		expect(() => loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: "short" }))).toThrow(
			/password/i,
		);
		expect(() =>
			loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: "alllowercasepassword" })),
		).toThrow(/password/i);
		expect(() =>
			loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: "ALLUPPERCASEPASSWORD" })),
		).toThrow(/password/i);
		expect(() =>
			loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: "NoDigitsHere!!!!" })),
		).toThrow(/password/i);
		expect(() =>
			loadRuntimeConfig(validEnv({ ADMIN_BOOTSTRAP_PASSWORD: "NoSpecialChars123" })),
		).toThrow(/password/i);
	});

	test("defaults concurrency to 4 and poll interval to 60 when omitted", () => {
		const config = loadRuntimeConfig(
			validEnv({
				MAX_CONCURRENT_JOBS: undefined,
				GITHUB_POLL_INTERVAL_SECONDS: undefined,
			}),
		);
		expect(config.worker.maxConcurrentJobs).toBe(4);
		expect(config.github.pollIntervalSeconds).toBe(60);
	});
});

describe("safeSerializeConfig", () => {
	test("never includes secrets in safe serialized configuration", () => {
		const config: RuntimeConfig = loadRuntimeConfig(validEnv());
		const safe = safeSerializeConfig(config);
		const json = JSON.stringify(safe);

		expect(json).not.toContain("postgres://");
		expect(json).not.toContain("Str0ng-P@ssw0rd-Enough!");
		expect(json).not.toContain("session-secret");
		expect(json).not.toContain(config.database.url);
		expect(json).not.toContain(config.admin.bootstrapPassword);
		expect(json).not.toContain(config.session.secret);

		expect(safe.workspace.roots).toEqual(["/var/workspaces", "/data/projects"]);
		expect(safe.worker.maxConcurrentJobs).toBe(4);
		expect(safe.github.pollIntervalSeconds).toBe(60);
		expect(safe.nodeEnv).toBe("development");
		expect(safe.database).toEqual({ configured: true });
		expect(safe.admin).toEqual({ bootstrapPasswordConfigured: true });
		expect(safe.session).toEqual({ secretConfigured: true });
	});
});
