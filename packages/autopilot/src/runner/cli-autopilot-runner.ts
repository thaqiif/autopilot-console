/**
 * CLI adapter implementing AutopilotRunner against the global autopilotagent.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { access, constants, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createNormalizedError, errorCodes } from "../../../shared/src/errors/normalized-error";
import { redactSecrets } from "../../../shared/src/security/redaction";
import { parseTaskBytes, readTaskFileAtomic, summarizeTaskFile } from "../task/task-reader";
import type {
	AutopilotRunHandle,
	AutopilotRunner,
	AutopilotStartRequest,
	CommitObservation,
	RuntimeValidation,
	SignalKind,
	TaskValidation,
	WaitOptions,
} from "./autopilot-runner";
import {
	createProcessIdentity,
	type ProcessIdentity,
	verifyProcessIdentity,
} from "./process-identity";
import {
	type NormalizedRunResult,
	normalizeRunResult,
	type ProgressSnapshot,
} from "./result-normalizer";

export type {
	AutopilotRunHandle,
	AutopilotRunner,
	AutopilotStartRequest,
	CommitObservation,
	RuntimeValidation,
	SignalKind,
	TaskValidation,
	WaitOptions,
} from "./autopilot-runner";

export interface CliAutopilotRunnerOptions {
	executablePath?: string;
	envAllowlist?: string[];
	maxDiagnosticBytes?: number;
}

interface LiveRun {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	exited: Promise<void>;
	handle: AutopilotRunHandle;
	lastValidProgress: ProgressSnapshot;
}

const DEFAULT_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

function emptyProgress(): ProgressSnapshot {
	return {
		total: 0,
		passed: 0,
		stuck: 0,
		invalidTest: 0,
		remaining: 0,
		allPass: false,
		blockedReasons: [],
	};
}

function adapterError(message: string, details?: Record<string, unknown>): never {
	throw createNormalizedError({
		code: errorCodes.ADAPTER_ERROR,
		message: redactSecrets(message),
		httpStatus: 502,
		details,
	});
}

function validationError(message: string): never {
	throw createNormalizedError({
		code: errorCodes.VALIDATION_FAILED,
		message: redactSecrets(message),
		httpStatus: 400,
	});
}

function assertRelativeTaskPath(taskRelativePath: string): void {
	if (!taskRelativePath || taskRelativePath.trim().length === 0) {
		validationError("task path must be non-empty");
	}
	if (isAbsolute(taskRelativePath)) {
		validationError("task path must be project-relative, not absolute");
	}
	if (taskRelativePath.includes("\0") || taskRelativePath.split(/[/\\]/).includes("..")) {
		validationError("task path must not contain traversal");
	}
	if (!taskRelativePath.toLowerCase().endsWith(".json")) {
		validationError("task path must end with .json");
	}
}

function buildEnv(allowlist: string[], extra?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of allowlist) {
		const v = process.env[key];
		if (v !== undefined) env[key] = v;
	}
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			if (allowlist.includes(k)) env[k] = v;
		}
	}
	return env;
}

function progressFromDocument(doc: {
	requirements: Array<{
		id: string;
		passes?: boolean;
		stuck?: boolean;
		invalidTest?: boolean;
		blockedReason?: string;
	}>;
}): ProgressSnapshot {
	const summary = summarizeTaskFile(doc as never);
	return {
		total: summary.total,
		passed: summary.passed,
		stuck: summary.stuck,
		invalidTest: summary.invalidTest,
		remaining: summary.pending,
		allPass: summary.allPass,
		blockedReasons: summary.blockedReasons,
	};
}

export class CliAutopilotRunner implements AutopilotRunner {
	private readonly executablePath: string;
	private readonly envAllowlist: string[];
	private readonly maxDiagnosticBytes: number;
	private readonly lives = new Map<string, LiveRun>();

	constructor(options: CliAutopilotRunnerOptions = {}) {
		this.executablePath = options.executablePath ?? "autopilotagent";
		this.envAllowlist = options.envAllowlist ?? DEFAULT_ALLOWLIST;
		this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? 64 * 1024;
	}

	private handleKey(handle: AutopilotRunHandle): string {
		return `${handle.projectId}:${handle.featureId}:${handle.processIdentity.pid}:${handle.startedAt}`;
	}

	async validateRuntime(): Promise<RuntimeValidation> {
		return this.validateRuntimePath(this.executablePath, "executable present");
	}

	async validateTask(projectRoot: string, taskRelativePath: string): Promise<TaskValidation> {
		assertRelativeTaskPath(taskRelativePath);
		const abs = resolve(projectRoot, taskRelativePath);
		const result = await readTaskFileAtomic({
			absolutePath: abs,
			relativePath: taskRelativePath,
			maxRetries: 1,
			retryDelayMs: 0,
		});
		if (!result.ok) {
			return {
				ok: false,
				message: result.errors.join("; ") || "task validation failed",
			};
		}
		return {
			ok: true,
			message: "task valid",
			checksum: result.snapshot.checksum,
		};
	}

	async start(request: AutopilotStartRequest): Promise<AutopilotRunHandle> {
		assertRelativeTaskPath(request.taskRelativePath);
		const executable = request.executablePath ?? this.executablePath;
		const runtime = await this.validateRuntimePath(executable);
		if (!runtime.ok) adapterError(runtime.message);

		const projectRoot = resolve(request.projectRoot);
		const absTask = resolve(projectRoot, request.taskRelativePath);
		// Ensure task is under project root.
		if (!absTask.startsWith(`${projectRoot}/`) && absTask !== projectRoot) {
			validationError("task path escapes project root");
		}

		const pre = await this.readProgress(projectRoot, request.taskRelativePath).catch(() =>
			emptyProgress(),
		);

		const env = buildEnv(this.envAllowlist, request.env);
		const child = spawn(executable, [request.taskRelativePath], {
			cwd: projectRoot,
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (child.pid == null) {
			adapterError("failed to spawn autopilotagent (no pid)");
		}

		const identity = await createProcessIdentity(child.pid);
		const handle: AutopilotRunHandle = {
			projectId: request.projectId,
			featureId: request.featureId,
			projectRoot,
			taskRelativePath: request.taskRelativePath,
			expectedBranch: request.expectedBranch,
			processIdentity: identity,
			startedAt: new Date().toISOString(),
		};

		const live: LiveRun = {
			child,
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: null,
			exited: new Promise((resolveExit) => {
				child.on("exit", (code, signal) => {
					live.exitCode = code;
					live.signal = signal;
					resolveExit();
				});
				child.on("error", () => {
					live.exitCode = live.exitCode ?? 1;
					resolveExit();
				});
			}),
			handle,
			lastValidProgress: pre,
		};

		child.stdout?.on("data", (buf: Buffer) => {
			live.stdout = this.appendDiagnostic(live.stdout, buf);
		});
		child.stderr?.on("data", (buf: Buffer) => {
			live.stderr = this.appendDiagnostic(live.stderr, buf);
		});

		this.lives.set(this.handleKey(handle), live);
		return handle;
	}

	private async validateRuntimePath(path: string, okMessage = "ok"): Promise<RuntimeValidation> {
		if (path.includes("/") || path.startsWith(".")) {
			try {
				await access(path, constants.X_OK);
				return { ok: true, message: okMessage, executablePath: path };
			} catch {
				return {
					ok: false,
					message: `autopilotagent executable not found or not executable: ${path}`,
					executablePath: path,
				};
			}
		}
		const which = Bun.which(path);
		if (!which) {
			return {
				ok: false,
				message: `autopilotagent executable not found on PATH: ${path}`,
			};
		}
		return { ok: true, message: okMessage, executablePath: which };
	}

	private appendDiagnostic(current: string, chunk: Buffer): string {
		const next = current + chunk.toString("utf8");
		const cap = this.maxDiagnosticBytes * 4;
		return next.length > cap ? next.slice(-this.maxDiagnosticBytes * 2) : next;
	}

	async isAlive(handle: AutopilotRunHandle): Promise<boolean> {
		const ok = await this.assertIdentity(handle);
		if (!ok) return false;
		try {
			process.kill(handle.processIdentity.pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async signal(handle: AutopilotRunHandle, kind: SignalKind): Promise<void> {
		const ok = await this.assertIdentity(handle);
		if (!ok) {
			adapterError("process identity mismatch; refusing to signal", {
				pid: handle.processIdentity.pid,
			});
		}
		const sig: NodeJS.Signals =
			kind === "graceful" ? "SIGUSR1" : kind === "term" ? "SIGTERM" : "SIGKILL";
		try {
			// For graceful stop also drop stop-signal sentinel (run.sh contract).
			if (kind === "graceful") {
				const featureDir = dirname(resolve(handle.projectRoot, handle.taskRelativePath));
				const stopPath = join(featureDir, "stop-signal");
				await writeFile(stopPath, "stop\n", "utf8").catch(() => undefined);
			}
			process.kill(handle.processIdentity.pid, sig);
		} catch (err) {
			adapterError(`failed to signal process: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async wait(handle: AutopilotRunHandle, options?: WaitOptions): Promise<NormalizedRunResult> {
		const live = this.lives.get(this.handleKey(handle));
		const timeoutMs = options?.timeoutMs;
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			validationError("wait timeout must be a finite, non-negative number");
		}

		if (live) {
			if (timeoutMs === undefined) {
				await live.exited;
			} else {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						live.exited,
						new Promise<void>((_, reject) => {
							timeout = setTimeout(
								() => reject(new Error(`wait timeout after ${timeoutMs}ms`)),
								timeoutMs,
							);
						}),
					]);
				} finally {
					if (timeout !== undefined) clearTimeout(timeout);
				}
			}
		} else {
			// No in-memory child handle (for example, after a worker restart): poll identity.
			const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
			while (true) {
				const alive = await this.isAlive(handle).catch(() => false);
				if (!alive) break;
				if (deadline !== undefined && Date.now() >= deadline) {
					throw new Error(`wait timeout after ${timeoutMs}ms`);
				}
				const sleepMs = deadline === undefined ? 50 : Math.min(50, deadline - Date.now());
				await Bun.sleep(Math.max(0, sleepMs));
			}
		}

		const signal = live?.signal ?? null;
		// Graceful SIGUSR1 stop: child may report null code + SIGUSR1; treat as 0.
		let exitCode = live?.exitCode ?? null;
		if (exitCode == null && signal === "SIGUSR1") {
			exitCode = 0;
		}
		const stdout = live?.stdout ?? "";
		const stderr = live?.stderr ?? "";

		const progress = await this.readProgress(handle.projectRoot, handle.taskRelativePath).catch(
			() => live?.lastValidProgress ?? emptyProgress(),
		);

		const notes = await this.readNotes(handle);
		const analytics = await this.readAnalytics(handle);

		const result = normalizeRunResult({
			exitCode,
			signal,
			progress,
			stdout,
			stderr,
			maxDiagnosticBytes: this.maxDiagnosticBytes,
			notes,
			analytics,
		});

		if (live) this.lives.delete(this.handleKey(handle));
		return result;
	}

	async readProgress(projectRoot: string, taskRelativePath: string): Promise<ProgressSnapshot> {
		assertRelativeTaskPath(taskRelativePath);
		const abs = resolve(projectRoot, taskRelativePath);
		const result = await readTaskFileAtomic({
			absolutePath: abs,
			relativePath: taskRelativePath,
			maxRetries: 3,
			retryDelayMs: 20,
		});
		if (!result.ok) {
			// Attempt raw parse for last-ditch; else empty.
			try {
				const bytes = await readFile(abs);
				const parsed = parseTaskBytes(bytes);
				if (parsed.ok) return progressFromDocument(parsed.document);
			} catch {
				// fall through
			}
			return emptyProgress();
		}
		return progressFromDocument(result.snapshot.document);
	}

	async observeCommits(handle: AutopilotRunHandle): Promise<CommitObservation[]> {
		const { spawnSync } = await import("node:child_process");
		const branch = handle.expectedBranch;
		const r = spawnSync("git", ["log", "--format=%H%x09%s%x09%aI", "-n", "20", branch], {
			cwd: handle.projectRoot,
			encoding: "utf8",
		});
		if (r.status !== 0) return [];
		return (r.stdout || "")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [hash, subject, authoredAt] = line.split("\t");
				return {
					hash: hash ?? "",
					subject: subject ?? "",
					authoredAt: authoredAt,
				};
			})
			.filter((c) => c.hash.length >= 7);
	}

	private async assertIdentity(handle: AutopilotRunHandle): Promise<boolean> {
		// Also verify project/feature carried on handle (caller responsibility to not forge those).
		if (!handle.projectId || !handle.featureId) return false;
		return verifyProcessIdentity(handle.processIdentity);
	}

	private async readNotes(handle: AutopilotRunHandle): Promise<NormalizedRunResult["notes"]> {
		const base = basename(handle.taskRelativePath, ".json");
		const featureDir = dirname(resolve(handle.projectRoot, handle.taskRelativePath));
		const notesPath = join(featureDir, `${base}-notes.md`);
		try {
			const content = await readFile(notesPath, "utf8");
			return { exists: true, content, path: notesPath };
		} catch {
			return { exists: false };
		}
	}

	private async readAnalytics(
		handle: AutopilotRunHandle,
	): Promise<NormalizedRunResult["analytics"]> {
		const featureDir = dirname(resolve(handle.projectRoot, handle.taskRelativePath));
		const analyticsDir = join(featureDir, "analytics");
		try {
			const files = await readdir(analyticsDir);
			const json = files.filter((f) => f.endsWith(".json")).sort();
			if (json.length === 0) return { exists: false };
			const latest = json[json.length - 1];
			if (latest == null) return { exists: false };
			const path = join(analyticsDir, latest);
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as { summary?: unknown };
			return { exists: true, summary: parsed.summary ?? parsed, path };
		} catch {
			return { exists: false };
		}
	}
}

// re-export identity helpers for tests that import from process-identity directly
export type { ProcessIdentity };
