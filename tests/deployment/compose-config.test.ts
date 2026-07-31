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
			const dockerfile = (build as Record<string, unknown>).dockerfile as string | undefined;
			// Monorepo builds use root context with specific dockerfile path
			if (context === "." || context === "./") {
				expect(dockerfile).toBeDefined();
				expect(dockerfile ?? "").toContain("apps/web");
			} else {
				expect(context).toContain("apps/web");
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
			const dockerfile = (build as Record<string, unknown>).dockerfile as string | undefined;
			if (context === "." || context === "./") {
				expect(dockerfile).toBeDefined();
				expect(dockerfile ?? "").toContain("apps/api");
			} else {
				expect(context).toContain("apps/api");
			}
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
			const dockerfile = (build as Record<string, unknown>).dockerfile as string | undefined;
			if (context === "." || context === "./") {
				expect(dockerfile).toBeDefined();
				expect(dockerfile ?? "").toContain("apps/worker");
			} else {
				expect(context).toContain("apps/worker");
			}
		}
	});

	test("postgres service uses a standard postgres image", () => {
		const services = getServices(readCompose());
		const pg = services.postgres as Record<string, unknown>;
		expect(pg.image).toBeDefined();
		expect(pg.image as string).toMatch(/^postgres:/);
	});
});

describe("production entrypoints", () => {
	test("API container starts the executable server entrypoint", () => {
		expect(fileExists("apps/api/src/main.ts")).toBe(true);
		expect(readFile("apps/api/Dockerfile")).toContain('CMD ["bun", "run", "apps/api/src/main.ts"]');
	});

	test("worker container starts its executable polling entrypoint", () => {
		expect(fileExists("apps/worker/src/main.ts")).toBe(true);
		expect(readFile("apps/worker/Dockerfile")).toContain(
			'CMD ["bun", "run", "apps/worker/src/main.ts"]',
		);
	});

	test("database package exposes an executable forward-only migration command", () => {
		expect(fileExists("packages/database/src/migrate.ts")).toBe(true);
		const packageJson = JSON.parse(readFile("packages/database/package.json")) as {
			scripts?: Record<string, string>;
		};
		expect(packageJson.scripts?.migrate).toBe("bun run src/migrate.ts");
	});
});

describe("production runtime wiring", () => {
	test("compose runs migrations before API and worker startup", () => {
		const services = getServices(readCompose());
		expect(services.migrate).toBeDefined();
		for (const name of ["api", "worker"] as const) {
			const dependencies = services[name]?.depends_on as Record<string, { condition?: string }>;
			expect(dependencies.migrate?.condition).toBe("service_completed_successfully");
		}
	});

	test("API and web expose real health checks", () => {
		const services = getServices(readCompose());
		expect(services.api?.healthcheck).toBeDefined();
		expect(services.web?.healthcheck).toBeDefined();
	});

	test("web uses an unprivileged nginx image and high container port", () => {
		const dockerfile = readFile("apps/web/Dockerfile");
		expect(dockerfile).toContain("nginx-unprivileged");
		expect(dockerfile).toContain("EXPOSE 8080");
		expect(readFile("apps/web/nginx.conf")).toContain("listen 8080");
	});
});

// ---------------------------------------------------------------------------
// Requirement 39: production Compose isolation, health, secrets, tools
// ---------------------------------------------------------------------------

describe("production compose stack (requirement 39)", () => {
	test("long-running services postgres, api, worker, and web each define a healthcheck", () => {
		const services = getServices(readCompose());
		for (const name of ["postgres", "api", "worker", "web"] as const) {
			const healthcheck = services[name]?.healthcheck as Record<string, unknown> | undefined;
			expect(healthcheck).toBeDefined();
			expect(healthcheck?.test).toBeDefined();
			const testValue = healthcheck?.test;
			const serialized = Array.isArray(testValue)
				? testValue.map(String).join(" ")
				: String(testValue ?? "");
			// Must be a real probe, not a no-op success command.
			expect(serialized).not.toMatch(/\btrue\b/);
			expect(serialized.length).toBeGreaterThan(0);
		}
	});

	test("worker healthcheck probes an internal live endpoint without publishing ports", () => {
		const services = getServices(readCompose());
		const worker = services.worker as Record<string, unknown>;
		const healthcheck = worker.healthcheck as Record<string, unknown> | undefined;
		expect(healthcheck).toBeDefined();
		const testValue = healthcheck?.test;
		const serialized = Array.isArray(testValue)
			? testValue.map(String).join(" ")
			: String(testValue ?? "");
		expect(serialized).toMatch(/health|live|ready/i);
		// Worker remains unexposed to the host.
		expect(worker.ports).toBeUndefined();
		// Entrypoint must serve the probe used by Compose.
		const workerMain = readFile("apps/worker/src/main.ts");
		const healthModule = readFile("apps/worker/src/health/worker-health-server.ts");
		expect(workerMain).toMatch(/createWorkerHealthServer/);
		expect(workerMain).toMatch(/healthPort|health\/live|healthServer/);
		expect(healthModule).toMatch(/Bun\.serve|serve\(/);
		expect(healthModule).toMatch(/\/health\/live/);
	});

	test("migrate is a one-shot service and dependents wait for successful completion", () => {
		const services = getServices(readCompose());
		const migrate = services.migrate as Record<string, unknown> | undefined;
		expect(migrate).toBeDefined();
		expect(migrate?.restart === "no" || migrate?.restart === false).toBe(true);
		const migrateDepends = migrate?.depends_on as
			| Record<string, { condition?: string }>
			| undefined;
		expect(migrateDepends?.postgres?.condition).toBe("service_healthy");
		for (const name of ["api", "worker"] as const) {
			const dependencies = services[name]?.depends_on as Record<string, { condition?: string }>;
			expect(dependencies.postgres?.condition).toBe("service_healthy");
			expect(dependencies.migrate?.condition).toBe("service_completed_successfully");
		}
		const webDepends = services.web?.depends_on as Record<string, { condition?: string }>;
		expect(webDepends.api?.condition).toBe("service_healthy");
	});

	test("required secrets use mandatory Compose interpolation and stay out of images", () => {
		const raw = readFile("compose.yaml");
		for (const key of [
			"POSTGRES_PASSWORD",
			"SESSION_SECRET",
			"ADMIN_BOOTSTRAP_PASSWORD",
			"AUTOPILOTAGENT_MOUNT",
		] as const) {
			expect(raw).toMatch(new RegExp(`\\$\\{${key}:\\?`));
		}
		// Worker must receive the same required authentication secrets as the API.
		const services = getServices(readCompose());
		const workerEnv = services.worker?.environment as Record<string, string> | undefined;
		expect(workerEnv?.SESSION_SECRET).toMatch(/\$\{SESSION_SECRET:\?/);
		expect(workerEnv?.ADMIN_BOOTSTRAP_PASSWORD).toMatch(/\$\{ADMIN_BOOTSTRAP_PASSWORD:\?/);
		expect(workerEnv?.AGENT_BIN).toMatch(/AGENT_BIN/);
		expect(workerEnv?.DIAGNOSTIC_LOG_DIR).toMatch(/\/app\/logs|DIAGNOSTIC_LOG_DIR/);
		for (const path of ["apps/api/Dockerfile", "apps/worker/Dockerfile", "apps/web/Dockerfile"]) {
			const content = readFile(path);
			expect(content).not.toMatch(/POSTGRES_PASSWORD\s*=\s*\S+/);
			expect(content).not.toMatch(/SESSION_SECRET\s*=\s*\S+/);
		}
	});

	test("only the worker receives a writable allowlisted project mount", () => {
		const services = getServices(readCompose());
		const workerVolumes = (services.worker?.volumes ?? []) as Array<
			string | Record<string, unknown>
		>;
		const apiVolumes = (services.api?.volumes ?? []) as Array<string | Record<string, unknown>>;
		const webVolumes = (services.web?.volumes ?? []) as Array<string | Record<string, unknown>>;

		const workerWritableProjects = workerVolumes.some((volume) => {
			if (typeof volume === "string") {
				return (
					(volume.includes("/projects") || volume.includes("WORKSPACE_MOUNT")) &&
					!volume.includes(":ro")
				);
			}
			const target = String((volume as Record<string, unknown>).target ?? "");
			const readOnly = (volume as Record<string, unknown>).read_only as boolean | undefined;
			return target.includes("/projects") && readOnly !== true;
		});
		expect(workerWritableProjects).toBe(true);

		const apiWritableProjects = apiVolumes.some((volume) => {
			if (typeof volume === "string") {
				return (
					(volume.includes("/projects") || volume.includes("WORKSPACE_MOUNT")) &&
					!volume.includes(":ro")
				);
			}
			const target = String((volume as Record<string, unknown>).target ?? "");
			const readOnly = (volume as Record<string, unknown>).read_only as boolean | undefined;
			return target.includes("/projects") && readOnly !== true;
		});
		expect(apiWritableProjects).toBe(false);

		const webHasProjectMount = webVolumes.some((volume) => {
			if (typeof volume === "string") {
				return volume.includes("/projects") || volume.includes("WORKSPACE_MOUNT");
			}
			const target = String((volume as Record<string, unknown>).target ?? "");
			return target.includes("/projects");
		});
		expect(webHasProjectMount).toBe(false);

		// Worker keeps durable diagnostics and a read-only Autopilotagent tool mount.
		const workerSerialized = workerVolumes.map(String).join("\n");
		expect(workerSerialized).toMatch(/diagnostic-logs|\/app\/logs/);
		expect(workerSerialized).toMatch(/AUTOPILOTAGENT_MOUNT.*:ro|\/opt\/autopilotagent:ro/);
	});

	test("worker image and startup validate git, jq, gh, agent CLI, and autopilotagent", () => {
		const dockerfile = readFile("apps/worker/Dockerfile");
		const compose = readFile("compose.yaml");
		const workerMain = readFile("apps/worker/src/main.ts");
		expect(dockerfile).toMatch(/\bgit\b/);
		expect(dockerfile).toMatch(/\bjq\b/);
		expect(dockerfile).toMatch(/\bgh\b/);
		expect(dockerfile).toMatch(/git --version && jq --version && gh --version/);
		expect(compose).toMatch(/\$\{AUTOPILOTAGENT_MOUNT:\?[^}]+\}:\/opt\/autopilotagent:ro/);
		expect(compose).toMatch(/AUTOPILOTAGENT_BIN:.*\/opt\/autopilotagent\/run\.sh/);
		expect(compose).toMatch(/AGENT_BIN:/);
		expect(workerMain).toMatch(/validateAgentCli/);
		expect(workerMain).toMatch(/validateRuntime\(\)/);
		expect(workerMain).toMatch(/AGENT_BIN/);
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
		const dependsOn = (api.depends_on ?? api.depends_on) as
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
		const dependsOn = (worker.depends_on ?? worker.depends_on) as
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
		const dependsOn = (web.depends_on ?? web.depends_on) as
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
		const volumeNames = Object.keys(volumes ?? {});
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
		expect(volumes?.length).toBeGreaterThan(0);
		const hasDataMount = volumes?.some((v) => {
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
		const volumeNames = Object.keys(volumes ?? {});
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
		expect(volumes?.length).toBeGreaterThan(0);
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
				return (v.includes("/workspace") || v.includes("/projects")) && !v.includes(":ro");
			}
			const target = (v as Record<string, unknown>).target as string;
			const readOnly = (v as Record<string, unknown>).read_only as boolean | undefined;
			return (target?.includes("/workspace") || target?.includes("/projects")) && !readOnly;
		});
		expect(hasWritableWorkspaceMount).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------

describe("secret and credential handling", () => {
	test("compose references secrets or environment variables for database credentials", () => {
		const _compose = readCompose();
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
	test("docker build context keeps required Bun and TypeScript configuration", () => {
		const ignored = readFile(".dockerignore")
			.split(/\r?\n/)
			.map((line) => line.trim());
		expect(ignored).not.toContain("bunfig.toml");
		expect(ignored).not.toContain("tsconfig.base.json");
	});

	test("Dockerfiles use Bun 1.3-compatible install flags", () => {
		for (const path of ["apps/api/Dockerfile", "apps/worker/Dockerfile", "apps/web/Dockerfile"]) {
			expect(readFile(path)).not.toContain("--production=false");
		}
	});

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

	test("worker tools are installed while autopilotagent is mounted and runtime-validated", () => {
		const dockerfile = readFile("apps/worker/Dockerfile");
		const compose = readFile("compose.yaml");
		const workerMain = readFile("apps/worker/src/main.ts");
		expect(dockerfile).toMatch(/git/);
		expect(dockerfile).toMatch(/jq/);
		expect(dockerfile).toMatch(/gh\b/);
		expect(dockerfile).not.toMatch(/tooling.*autopilotagent/i);
		expect(compose).toMatch(/\$\{AUTOPILOTAGENT_MOUNT:\?[^}]+\}:\/opt\/autopilotagent:ro/);
		expect(compose).toContain("/opt/autopilotagent/run.sh");
		expect(workerMain).toMatch(/validateRuntime\(\)/);
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

	test("packages/shared/src/observability/diagnostic-retention.ts exists", () => {
		expect(fileExists("packages/shared/src/observability/diagnostic-retention.ts")).toBe(true);
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

	test("metrics module covers durations interruptions adapter errors polling lag and attention", () => {
		const content = readFile("packages/shared/src/observability/metrics.ts");
		expect(content).toMatch(/duration/i);
		expect(content).toMatch(/interrupt/i);
		expect(content).toMatch(/adapter/i);
		expect(content).toMatch(/polling.?lag/i);
		expect(content).toMatch(/attention/i);
	});

	test("API entrypoint wires structured logging and metrics emission", () => {
		const main = readFile("apps/api/src/main.ts");
		expect(main).toMatch(/createStructuredLogger/);
		expect(main).toMatch(/createMetricsCollector/);
		expect(main).toMatch(/logger\.(info|error)/);
	});

	test("worker entrypoint wires structured logging metrics agent validation and diagnostic retention", () => {
		const main = readFile("apps/worker/src/main.ts");
		expect(main).toMatch(/createStructuredLogger/);
		expect(main).toMatch(/createMetricsCollector/);
		expect(main).toMatch(/createDiagnosticLogRetention|DiagnosticLogRetention/);
		expect(main).toMatch(/AGENT_BIN/);
		expect(main).toMatch(/validateRuntime\(\)/);
		expect(main).toMatch(/logger\.(info|error)/);
	});

	test("shared package exports diagnostic retention helpers", () => {
		const index = readFile("packages/shared/src/index.ts");
		expect(index).toMatch(/createDiagnosticLogRetention/);
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
