export type NodeEnv = "development" | "test" | "production";

export interface RuntimeConfig {
	nodeEnv: NodeEnv;
	database: { url: string };
	admin: { bootstrapPassword: string };
	session: { secret: string };
	workspace: { roots: string[] };
	worker: { maxConcurrentJobs: number };
	github: { pollIntervalSeconds: number };
}

export interface SafeRuntimeConfig {
	nodeEnv: NodeEnv;
	database: { configured: true };
	admin: { bootstrapPasswordConfigured: true };
	session: { secretConfigured: true };
	workspace: { roots: string[] };
	worker: { maxConcurrentJobs: number };
	github: { pollIntervalSeconds: number };
}

const MIN_PASSWORD_LENGTH = 12;
const MIN_SESSION_SECRET_LENGTH = 16;
const DEFAULT_MAX_CONCURRENT_JOBS = 4;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const MAX_CONCURRENT_JOBS_LIMIT = 10;
const MAX_POLL_INTERVAL_SECONDS = 3600;

function readString(env: Record<string, string | undefined>, key: string): string | undefined {
	const raw = env[key];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
	label: string,
	min: number,
	max: number,
): number {
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error(`Invalid ${label}: must be an integer`);
	}
	const value = Number.parseInt(raw.trim(), 10);
	if (value < min || value > max) {
		throw new Error(`Invalid ${label}: must be between ${min} and ${max}`);
	}
	return value;
}

function parseWorkspaceRoots(raw: string | undefined): string[] {
	if (raw === undefined) {
		throw new Error("Missing workspace roots allowlist (WORKSPACE_ROOTS)");
	}
	const roots = raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (roots.length === 0) {
		throw new Error("Empty workspace roots allowlist (WORKSPACE_ROOTS)");
	}
	return roots;
}

function assertStrongPassword(password: string | undefined): string {
	if (password === undefined) {
		throw new Error("Missing admin bootstrap password");
	}
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Weak bootstrap password: must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	if (!/[a-z]/.test(password)) {
		throw new Error("Weak bootstrap password: must include a lowercase letter");
	}
	if (!/[A-Z]/.test(password)) {
		throw new Error("Weak bootstrap password: must include an uppercase letter");
	}
	if (!/[0-9]/.test(password)) {
		throw new Error("Weak bootstrap password: must include a digit");
	}
	if (!/[^A-Za-z0-9]/.test(password)) {
		throw new Error("Weak bootstrap password: must include a special character");
	}
	return password;
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
	if (raw === undefined || raw === "development") return "development";
	if (raw === "test" || raw === "production") return raw;
	throw new Error(`Invalid NODE_ENV: ${raw}`);
}

/**
 * Load and validate deployment runtime configuration from environment-like input.
 * Secrets stay on the returned object; use {@link safeSerializeConfig} for logs/UI.
 */
export function loadRuntimeConfig(
	env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
	const databaseUrl = readString(env, "DATABASE_URL");
	if (databaseUrl === undefined) {
		throw new Error("Missing database settings (DATABASE_URL)");
	}

	const sessionSecret = readString(env, "SESSION_SECRET");
	if (sessionSecret === undefined) {
		throw new Error("Missing session secret (SESSION_SECRET)");
	}
	if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
		throw new Error(
			`Weak session secret: must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
		);
	}

	const bootstrapPassword = assertStrongPassword(readString(env, "ADMIN_BOOTSTRAP_PASSWORD"));

	const maxConcurrentJobs = parsePositiveInt(
		readString(env, "MAX_CONCURRENT_JOBS"),
		DEFAULT_MAX_CONCURRENT_JOBS,
		"concurrency limit (MAX_CONCURRENT_JOBS)",
		1,
		MAX_CONCURRENT_JOBS_LIMIT,
	);

	const pollIntervalSeconds = parsePositiveInt(
		readString(env, "GITHUB_POLL_INTERVAL_SECONDS"),
		DEFAULT_POLL_INTERVAL_SECONDS,
		"poll interval (GITHUB_POLL_INTERVAL_SECONDS)",
		1,
		MAX_POLL_INTERVAL_SECONDS,
	);

	return {
		nodeEnv: parseNodeEnv(readString(env, "NODE_ENV")),
		database: { url: databaseUrl },
		admin: { bootstrapPassword },
		session: { secret: sessionSecret },
		workspace: { roots: parseWorkspaceRoots(readString(env, "WORKSPACE_ROOTS")) },
		worker: { maxConcurrentJobs },
		github: { pollIntervalSeconds },
	};
}

/** Safe view of config for logs, health, and UI — never includes secret material. */
export function safeSerializeConfig(config: RuntimeConfig): SafeRuntimeConfig {
	return {
		nodeEnv: config.nodeEnv,
		database: { configured: true },
		admin: { bootstrapPasswordConfigured: true },
		session: { secretConfigured: true },
		workspace: { roots: [...config.workspace.roots] },
		worker: { maxConcurrentJobs: config.worker.maxConcurrentJobs },
		github: { pollIntervalSeconds: config.github.pollIntervalSeconds },
	};
}
