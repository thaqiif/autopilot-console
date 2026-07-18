/**
 * Fixed-argv git CLI runner. No shell, no arbitrary caller commands.
 */

import { spawnSync } from "node:child_process";
import { createNormalizedError, errorCodes } from "../../shared/src/errors/normalized-error";
import { redactSecrets } from "../../shared/src/security/redaction";

export type AllowedGitSubcommand =
	| "rev-parse"
	| "symbolic-ref"
	| "status"
	| "remote"
	| "fetch"
	| "branch"
	| "checkout"
	| "log"
	| "push"
	| "ls-remote"
	| "show-ref"
	| "config";

const ALLOWED = new Set<string>([
	"rev-parse",
	"symbolic-ref",
	"status",
	"remote",
	"fetch",
	"branch",
	"checkout",
	"log",
	"push",
	"ls-remote",
	"show-ref",
	"config",
]);

const FORBIDDEN_FLAG = /^(--force|--force-with-lease|-f|--hard|--soft|--mixed)$/;

function adapterError(message: string, details?: Record<string, unknown>): never {
	throw createNormalizedError({
		code: errorCodes.ADAPTER_ERROR,
		message: redactSecrets(message),
		httpStatus: 502,
		details,
	});
}

export interface GitRunResult {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Run `git <subcommand> ...args` with shell disabled and fixed allowlisted subcommands.
 */
export function runGit(
	cwd: string,
	subcommand: AllowedGitSubcommand,
	args: readonly string[] = [],
): GitRunResult {
	if (!ALLOWED.has(subcommand)) {
		adapterError(`git subcommand not allowed: ${subcommand}`);
	}
	for (const a of args) {
		if (FORBIDDEN_FLAG.test(a)) {
			adapterError(`git flag not allowed: ${a}`);
		}
		// Block shell metacharacters in args (defense in depth; we never use shell).
		if (a.includes("\0")) {
			adapterError("git argument contains NUL");
		}
	}

	const r = spawnSync("git", [subcommand, ...args], {
		cwd,
		encoding: "utf8",
		shell: false,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			TMPDIR: process.env.TMPDIR,
			LANG: process.env.LANG,
			LC_ALL: process.env.LC_ALL,
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	});

	if (r.error) {
		adapterError(`git spawn failed: ${r.error.message}`);
	}

	return {
		status: r.status ?? 1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
}

export function runGitOk(
	cwd: string,
	subcommand: AllowedGitSubcommand,
	args: readonly string[] = [],
): string {
	const r = runGit(cwd, subcommand, args);
	if (r.status !== 0) {
		adapterError(`git ${subcommand} failed`, {
			status: r.status,
			stderr: redactSecrets(r.stderr.trim()).slice(0, 500),
		});
	}
	return r.stdout.trim();
}
