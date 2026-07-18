/**
 * Deployment configuration tests (requirement 30).
 *
 * These tests parse Compose YAML, Dockerfiles, and supporting files to assert
 * service separation, persistent storage, tool availability, secret handling,
 * non-root runtime, health dependencies, and workspace-mount isolation.
 *
 * RED phase: files referenced here do not yet exist so every assertion fails.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dir, "../..");

function readFile(relativePath: string): string {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

function fileExists(relativePath: string): boolean {
	return existsSync(join(ROOT, relativePath));
}

function readCompose(): Record<string, unknown> {
	const raw = readFile("compose.yaml");
	return parseYaml(raw) as Record<string, unknown>;
}

function getServices(compose: Record<string, unknown>): Record<string, Record<string, unknown>> {
	return (compose.services ?? {}) as Record<string, Record<string, unknown>>;
}

function getVolumes(compose: Record<string, unknown>): Record<string, unknown> | undefined {
	return compose.volumes as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Compose file existence and validity
// ---------------------------------------------------------------------------

describe("compose file", () => {
	test("compose.yaml exists at project root", () => {
		expect(fileExists("compose.yaml")).toBe(true);
	});

	test("compose.yaml is valid YAML with a services key", () => {
		const compose = readCompose();
		expect(compose.services).toBeDefined();
		expect(typeof compose.services).toBe("object");
	});

	test(".dockerignore exists at project root", () => {
		expect(fileExists(".dockerignore")).toBe(true);
	});

	test(".env.example exists at project root", () => {
		expect(fileExists(".env.example")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Service separation
// ---------------------------------------------------------------------------

describe("service separation", () => {
	test("compose defines separate web, api, worker, and postgres services", () => {
		const services = getServices(readCompose());
		expect(services.web).toBeDefined();
		expect(services.api).toBeDefined();
		expect(services.worker).toBeDefined();
		expect(services.postgres).toBeDefined();
	});

	test("web service builds from apps/web/Dockerfile", () => {
		const services = getServices(readCompose());
		const web = services.web as Record<string, unknown>;
		const build = web.build as string | Record<string, unknown> | undefined;
		expect(build).toBeDefined();
		if (typeof build === "string") {
			expect(build).toContain("apps/web");
		} else {
			const context = (build as Record<string, unknown>).context as string;
			expect(context).toContain("apps/web");
			const dockerfile = (build as Record<string, unknown>).dockerfile as string | undefined;
			if (dockerfile) {
				expect(dockerfile).toMatch(/Dockerfile/i);
			}
		}
	});

	test("api service builds from apps/api/Dockerfile", () => {
		const services = getServices(readCompose());
		const api = services.api as Record<string, unknown>;
		const build = api.build as string | Record<string, unknown> | undefined;
		expect(build).toBeDefined();
		if (typeof build === "string") {
			expect(build).toContain("apps/api");
		} else {
			const context = (build as Record<string, unknown>).context as string;
			expect(context).toContain("apps/api");
		}
	});

	test("worker service builds from apps/worker/Dockerfile", () => {
		const services = getServices(readCompose());
		const worker = services.worker as Record<string, unknown>;
		const build = worker.build as string | Record<string, unknown> | undefined;
		expect(build).toBeDefined();
		if (typeof build === "string") {
			expect(build).toContain("apps/worker");
		} else {
			const context = (build as Record<string, unknown>).context as string;
			expect(context).toContain("apps/worker");
		}
	});

	test("postgres service uses a standard postgres image", () => {
		const services = getServices(readCompose());
		const pg = services.postgres as Record<string, unknown>;
		expect(pg.image).toBeDefined();
		expect(pg.image as string).toMatch(/^postgres:/);
	});
});

// ---------------------------------------------------------------------------
// Health checks and dependency ordering
// ---------------------------------------------------------------------------

describe("health checks and dependency ordering", () => {
	test("postgres service has a health check", () => {
		const services = getServices(readCompose());
		const pg = services.postgres as Record<string, unknown>;
		expect(pg.healthcheck).toBeDefined();
		const hc = pg.healthcheck as Record<string, unknown>;
		expect(hc.test).toBeDefined();
	});

	test("api depends_on postgres with condition service_healthy", () => {
		const services = getServices(readCompose());
		const api = services.api as Record<string, unknown>;
		const dependsOn = (api.depends_on ?? api["depends_on"]) as
			| Record<string, unknown>
			| string[]
			| undefined;
		expect(dependsOn).toBeDefined();
		if (Array.isArray(dependsOn)) {
			expect(dependsOn).toContain("postgres");
		} else {
			const pgDep = (dependsOn as Record<string, unknown>).postgres as
				| Record<string, unknown>
				| undefined;
			expect(pgDep).toBeDefined();
			if (pgDep) {
				expect(pgDep.condition as string).toMatch(/service_healthy/);
			}
		}
	});

	test("worker depends_on postgres with condition service_healthy", () => {
		const services = getServices(readCompose());
		const worker = services.worker as Record<string, unknown>;
		const dependsOn = (worker.depends_on ?? worker["depends_on"]) as
			| Record<string, unknown>
			| string[]
			| undefined;
		expect(dependsOn).toBeDefined();
		if (Array.isArray(dependsOn)) {
			expect(dependsOn).toContain("postgres");
		} else {
			const pgDep = (dependsOn as Record<string, unknown>).postgres as
				| Record<string, unknown>
				| undefined;
			expect(pgDep).toBeDefined();
			if (pgDep) {
				expect(pgDep.condition as string).toMatch(/service_healthy/);
			}
		}
	});

	test("web depends_on api", () => {
		const services = getServices(readCompose());
		const web = services.web as Record<string, unknown>;
		const dependsOn = (web.depends_on ?? web["depends_on"]) as
			| Record<string, unknown>
			| string[]
			| undefined;
		expect(dependsOn).toBeDefined();
		if (Array.isArray(dependsOn)) {
			expect(dependsOn).toContain("api");
		} else {
			expect((dependsOn as Record<string, unknown>).api).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Persistent volumes
// ---------------------------------------------------------------------------

describe("persistent volumes", () => {
	test("compose defines a named volume for postgres data", () => {
		const compose = readCompose();
		const volumes = getVolumes(compose);
		expect(volumes).toBeDefined();
		const volumeNames = Object.keys(volumes!);
		const hasPgVolume = volumeNames.some(
			(name) => name.toLowerCase().includes("postgres") || name.toLowerCase().includes("db"),
		);
		expect(hasPgVolume).toBe(true);
	});

	test("postgres service mounts the database volume", () => {
		const services = getServices(readCompose());
		const pg = services.postgres as Record<string, unknown>;
		const volumes = pg.volumes as Array<string | Record<string, unknown>> | undefined;
		expect(volumes).toBeDefined();
		expect(volumes!.length).toBeGreaterThan(0);
		const hasDataMount = volumes!.some((v) => {
			if (typeof v === "string") return v.includes("/var/lib/postgresql/data");
			const target = (v as Record<string, unknown>).target as string;
			return target?.includes("/var/lib/postgresql/data");
		});
		expect(hasDataMount).toBe(true);
	});

	test("compose defines a named or bounded volume for diagnostic logs", () => {
		const compose = readCompose();
		const volumes = getVolumes(compose);
		expect(volumes).toBeDefined();
		const volumeNames = Object.keys(volumes!);
		const hasDiagVolume = volumeNames.some(
			(name) =>
				name.toLowerCase().includes("diag") ||
				name.toLowerCase().includes("log") ||
				name.toLowerCase().includes("audit"),
		);
		expect(hasDiagVolume).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Worker workspace mounts and isolation
// ---------------------------------------------------------------------------

describe("workspace mount isolation", () => {
	test("worker service has a workspace mount", () => {
		const services = getServices(readCompose());
		const worker = services.worker as Record<string, unknown>;
		const volumes = worker.volumes as Array<string | Record<string, unknown>> | undefined;
		expect(volumes).toBeDefined();
		expect(volumes!.length).toBeGreaterThan(0);
	});

	test("web service does NOT have a host workspace mount", () => {
		const services = getServices(readCompose());
		const web = services.web as Record<string, unknown>;
		const volumes = (web.volumes ?? []) as Array<string | Record<string, unknown>>;
		const hasWorkspaceMount = volumes.some((v) => {
			if (typeof v === "string") return v.includes("/workspace") || v.includes("/projects");
			const target = (v as Record<string, unknown>).target as string;
			return target?.includes("/workspace") || target?.includes("/projects");
		});
		expect(hasWorkspaceMount).toBe(false);
	});

	test("api service does NOT have a writable host workspace mount", () => {
		const services = getServices(readCompose());
		const api = services.api as Record<string, unknown>;
		const volumes = (api.volumes ?? []) as Array<string | Record<string, unknown>>;
		const hasWritableWorkspaceMount = volumes.some((v) => {
			if (typeof v === "string") {
				// A writable bind mount has no :ro suffix and points to a source tree
				return (
					(v.includes("/workspace") || v.includes("/projects")) && !v.includes(":ro")
				);
			}
			const target = (v as Record<string, unknown>).target as string;
			const readOnly = (v as Record<string, unknown>).read_only as boolean | undefined;
			return (
				(target?.includes("/workspace") || target?.includes("/projects")) && !readOnly
			);
		});
		expect(hasWritableWorkspaceMount).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------

describe("secret and credential handling", () => {
	test("compose references secrets or environment variables for database credentials", () => {
		const compose = readCompose();
		const raw = readFile("compose.yaml");
		// Database credentials must come from env, not hardcoded
		expect(raw).not.toMatch(/POSTGRES_PASSWORD:\s*[a-zA-Z0-9]{8,}/);
		// Must reference a variable or secret
		expect(raw).toMatch(/POSTGRES_PASSWORD/);
	});

	test("compose references SESSION_SECRET from environment", () => {
		const raw = readFile("compose.yaml");
		expect(raw).toMatch(/SESSION_SECRET/);
		expect(raw).not.toMatch(/SESSION_SECRET:\s*[a-zA-Z0-9]{16,}/);
	});

	test("compose references ADMIN_BOOTSTRAP_PASSWORD from environment", () => {
		const raw = readFile("compose.yaml");
		expect(raw).toMatch(/ADMIN_BOOTSTRAP_PASSWORD/);
	});

	test("compose references GITHUB_TOKEN or GH_TOKEN from environment", () => {
		const raw = readFile("compose.yaml");
		expect(raw).toMatch(/(?:GITHUB_TOKEN|GH_TOKEN)/);
	});

	test(".env.example contains placeholder values not real secrets", () => {
		const envExample = readFile(".env.example");
		// Should contain the key variable names
		expect(envExample).toMatch(/DATABASE_URL/);
		expect(envExample).toMatch(/SESSION_SECRET/);
		expect(envExample).toMatch(/ADMIN_BOOTSTRAP_PASSWORD/);
		// Should NOT contain real-looking passwords or tokens
		expect(envExample).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
		expect(envExample).not.toMatch(/github_pat_/);
		// Example values should be clearly marked as placeholders
		expect(envExample).toMatch(/change-me|example|placeholder|your-|REPLACE/i);
	});
});

// ---------------------------------------------------------------------------
// Dockerfiles
// ---------------------------------------------------------------------------

describe("dockerfiles", () => {
	test("apps/web/Dockerfile exists", () => {
		expect(fileExists("apps/web/Dockerfile")).toBe(true);
	});

	test("apps/api/Dockerfile exists", () => {
		expect(fileExists("apps/api/Dockerfile")).toBe(true);
	});

	test("apps/worker/Dockerfile exists", () => {
		expect(fileExists("apps/worker/Dockerfile")).toBe(true);
	});

	test("all Dockerfiles use a Bun base image or install Bun", () => {
		for (const dockerfile of [
			"apps/web/Dockerfile",
			"apps/api/Dockerfile",
			"apps/worker/Dockerfile",
		]) {
			const content = readFile(dockerfile);
			const hasBun =
				content.toLowerCase().includes("oven/bun") ||
				content.toLowerCase().includes("bun install") ||
				content.toLowerCase().includes("bun run");
			expect(hasBun).toBe(true);
		}
	});

	test("all Dockerfiles run as non-root user", () => {
		for (const dockerfile of [
			"apps/web/Dockerfile",
			"apps/api/Dockerfile",
			"apps/worker/Dockerfile",
		]) {
			const content = readFile(dockerfile);
			expect(content).toMatch(/USER\s+\w+/);
			// Should not run as root
			expect(content).not.toMatch(/USER\s+root\b/i);
		}
	});

	test("no Dockerfile contains hardcoded secrets or tokens", () => {
		for (const dockerfile of [
			"apps/web/Dockerfile",
			"apps/api/Dockerfile",
			"apps/worker/Dockerfile",
		]) {
			const content = readFile(dockerfile);
			expect(content).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
			expect(content).not.toMatch(/github_pat_/);
			expect(content).not.toMatch(/password\s*=\s*\S{8,}/i);
		}
	});

	test("worker Dockerfile validates or installs autopilotagent, git, jq, and gh", () => {
		const content = readFile("apps/worker/Dockerfile");
		expect(content).toMatch(/git/);
		expect(content).toMatch(/jq/);
		expect(content).toMatch(/gh\b/);
		// Worker must have autopilotagent available (via PATH, COPY, or validation)
		expect(content).toMatch(/autopilot/i);
	});
});

// ---------------------------------------------------------------------------
// Structured logging and metrics
// ---------------------------------------------------------------------------

describe("structured observability", () => {
	test("packages/shared/src/observability/structured-logger.ts exists", () => {
		expect(fileExists("packages/shared/src/observability/structured-logger.ts")).toBe(true);
	});

	test("packages/shared/src/observability/metrics.ts exists", () => {
		expect(fileExists("packages/shared/src/observability/metrics.ts")).toBe(true);
	});

	test("structured logger supports correlation, project, feature, and job context", () => {
		const content = readFile("packages/shared/src/observability/structured-logger.ts");
		expect(content).toMatch(/correlation/i);
		expect(content).toMatch(/project/i);
		expect(content).toMatch(/feature/i);
		expect(content).toMatch(/job/i);
	});

	test("structured logger redacts sensitive fields before output", () => {
		const content = readFile("packages/shared/src/observability/structured-logger.ts");
		expect(content).toMatch(/redact/i);
	});

	test("metrics module exports queue depth, active jobs, oldest age, and heartbeat age", () => {
		const content = readFile("packages/shared/src/observability/metrics.ts");
		expect(content).toMatch(/queue.?depth/i);
		expect(content).toMatch(/active.?jobs?/i);
		expect(content).toMatch(/oldest.?age/i);
		expect(content).toMatch(/heartbeat/i);
	});
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

describe("operator documentation", () => {
	test("docs/deployment.md exists", () => {
		expect(fileExists("docs/deployment.md")).toBe(true);
	});

	test("docs/operations.md exists", () => {
		expect(fileExists("docs/operations.md")).toBe(true);
	});

	test("deployment docs cover prerequisites including Bun and autopilotagent", () => {
		const content = readFile("docs/deployment.md");
		expect(content).toMatch(/bun/i);
		expect(content).toMatch(/autopilot/i);
	});

	test("deployment docs cover secrets and environment configuration", () => {
		const content = readFile("docs/deployment.md");
		expect(content).toMatch(/secret/i);
		expect(content).toMatch(/environment|\.env/i);
	});

	test("deployment docs cover database migrations", () => {
		const content = readFile("docs/deployment.md");
		expect(content).toMatch(/migrat/i);
	});

	test("operations docs cover backup and recovery", () => {
		const content = readFile("docs/operations.md");
		expect(content).toMatch(/backup/i);
		expect(content).toMatch(/recover/i);
	});

	test("operations docs cover cancellation and interruption handling", () => {
		const content = readFile("docs/operations.md");
		expect(content).toMatch(/cancel/i);
		expect(content).toMatch(/interrupt/i);
	});

	test("operations docs cover safe upgrades", () => {
		const content = readFile("docs/operations.md");
		expect(content).toMatch(/upgrade/i);
	});
});

// ---------------------------------------------------------------------------
// .dockerignore
// ---------------------------------------------------------------------------

describe("dockerignore", () => {
	test(".dockerignore excludes node_modules", () => {
		const content = readFile(".dockerignore");
		expect(content).toMatch(/node_modules/);
	});

	test(".dockerignore excludes .git", () => {
		const content = readFile(".dockerignore");
		expect(content).toMatch(/\.git/);
	});

	test(".dockerignore excludes docs and test artifacts", () => {
		const content = readFile(".dockerignore");
		expect(content).toMatch(/docs|coverage|\.autopilotagent/);
	});
});
