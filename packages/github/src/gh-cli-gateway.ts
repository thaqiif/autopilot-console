/**
 * CLI implementation of GitHubGateway — fixed gh argv, shell disabled, JSON only.
 */

import { spawnSync } from "node:child_process";
import { adapterError, redactText, validationError } from "./errors";
import {
	parseAuthHosts,
	parseJsonStdout,
	parsePrList,
	parsePrListItem,
	parsePrView,
	parseRepoView,
} from "./gh-json-schemas";
import type {
	CreatePullRequestRequest,
	FindPullRequestRequest,
	GetPullRequestStatusRequest,
	GitHubGateway,
	PullRequestIdentity,
	PullRequestStatus,
	RepositoryRef,
	ValidateAccessRequest,
	ValidateAccessResult,
} from "./github-gateway";
import { normalizePullRequestStatus } from "./status-normalizer";

export type GhRunResult = { status: number; stdout: string; stderr: string };

export type GhRunner = (
	argv: readonly string[],
	options?: { cwd?: string; env?: Record<string, string | undefined> },
) => GhRunResult;

export interface GhCliGatewayOptions {
	/** Injectable runner for tests. Default: real gh spawn. */
	runGh?: GhRunner;
	executablePath?: string;
}

const PR_IDENTITY_JSON = "number,url,headRefName,baseRefName,headRefOid,state,title";
const PR_STATUS_JSON =
	"number,url,headRefName,baseRefName,headRefOid,state,reviewDecision,mergeCommit,mergedAt,closedAt,updatedAt,mergeable,statusCheckRollup";

function defaultRunGh(executablePath: string): GhRunner {
	return (argv, options) => {
		const r = spawnSync(executablePath, [...argv], {
			cwd: options?.cwd,
			encoding: "utf8",
			shell: false,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				LANG: process.env.LANG,
				LC_ALL: process.env.LC_ALL,
				GH_PROMPT_DISABLED: "1",
				GH_NO_UPDATE_NOTIFIER: "1",
				// Do not forward GH_TOKEN into child unless already present via allowlist —
				// default spawn uses process.env stripped to essentials + caller env override.
				...(options?.env ?? {
					GH_TOKEN: process.env.GH_TOKEN,
					GITHUB_TOKEN: process.env.GITHUB_TOKEN,
				}),
			},
		});
		if (r.error) {
			adapterError(`gh spawn failed: ${r.error.message}`);
		}
		return {
			status: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
		};
	};
}

function assertRepo(repository: RepositoryRef): void {
	if (!repository.owner || !repository.repository || !repository.fullName) {
		validationError("repository identity is required");
	}
	if (repository.fullName !== `${repository.owner}/${repository.repository}`) {
		validationError("repository.fullName must equal owner/repository");
	}
}

function repoFlag(repository: RepositoryRef): string[] {
	return ["--repo", repository.fullName];
}

function safeFailure(code: string, message: string): { code: string; message: string } {
	return { code, message: redactText(message).slice(0, 500) };
}

export class GhCliGateway implements GitHubGateway {
	private readonly run: GhRunner;

	constructor(options: GhCliGatewayOptions = {}) {
		const exe = options.executablePath ?? "gh";
		this.run = options.runGh ?? defaultRunGh(exe);
	}

	/** Invoke fixed gh argv; reject merge/approve verbs. */
	#invoke(argv: readonly string[]): GhRunResult {
		if (argv.includes("merge") || argv.includes("approve")) {
			adapterError("gh merge/approve operations are not allowed");
		}
		return this.run(argv);
	}

	/**
	 * Session-level authentication probe used by readiness when no project
	 * repository is available. Never returns credentials or raw command output.
	 */
	async validateAuthentication(): Promise<{
		ok: boolean;
		authenticated: boolean;
		login: string | null;
	}> {
		const auth = this.#invoke(["auth", "status", "--json", "hosts"]);
		if (auth.status !== 0) {
			return { ok: false, authenticated: false, login: null };
		}
		try {
			const parsed = parseAuthHosts(parseJsonStdout(auth.stdout));
			return {
				ok: parsed.ok,
				authenticated: parsed.ok,
				login: parsed.login,
			};
		} catch {
			return { ok: false, authenticated: false, login: null };
		}
	}

	async validateAccess(request: ValidateAccessRequest): Promise<ValidateAccessResult> {
		assertRepo(request.repository);
		const failures: Array<{ code: string; message: string }> = [];
		let authenticated = false;
		let login: string | null = null;
		let repositoryReadable = false;
		let pushFeasible: boolean | null = null;

		const auth = await this.validateAuthentication();
		authenticated = auth.authenticated;
		login = auth.login;
		if (!authenticated) {
			failures.push(safeFailure("AUTH_REQUIRED", "No successful GitHub authentication"));
			return {
				ok: false,
				authenticated: false,
				login: null,
				repositoryReadable: false,
				pushFeasible: null,
				failures,
			};
		}

		// Non-mutating repository probe with machine-readable fields.
		const repoView = this.#invoke([
			"repo",
			"view",
			request.repository.fullName,
			"--json",
			"name,owner,viewerPermission",
		]);
		if (repoView.status !== 0) {
			failures.push(
				safeFailure(
					"REPOSITORY_ACCESS_DENIED",
					repoView.stderr.trim() || "repository not readable",
				),
			);
			return {
				ok: false,
				authenticated,
				login,
				repositoryReadable: false,
				pushFeasible: null,
				failures,
			};
		}

		try {
			const repo = parseRepoView(parseJsonStdout(repoView.stdout));
			repositoryReadable =
				repo.name.toLowerCase() === request.repository.repository.toLowerCase() &&
				repo.ownerLogin.toLowerCase() === request.repository.owner.toLowerCase();
			if (!repositoryReadable) {
				failures.push(safeFailure("REPOSITORY_ACCESS_DENIED", "repository identity mismatch"));
			}
			const perm = (repo.viewerPermission ?? "").toUpperCase();
			if (perm === "ADMIN" || perm === "MAINTAIN" || perm === "WRITE") {
				pushFeasible = true;
			} else if (perm === "TRIAGE" || perm === "READ") {
				pushFeasible = false;
			} else {
				pushFeasible = null;
			}
		} catch (e) {
			failures.push(
				safeFailure(
					"REPOSITORY_ACCESS_DENIED",
					e instanceof Error ? e.message : "invalid repo view JSON",
				),
			);
			repositoryReadable = false;
		}

		const ok = authenticated && repositoryReadable && failures.length === 0;
		return {
			ok,
			authenticated,
			login,
			repositoryReadable,
			pushFeasible,
			failures,
		};
	}

	async findExistingPullRequest(
		request: FindPullRequestRequest,
	): Promise<PullRequestIdentity | null> {
		assertRepo(request.repository);
		if (!request.headBranch || !request.baseBranch) {
			validationError("headBranch and baseBranch are required");
		}

		const requested = request.state ?? "all";
		// Prefer open first, then merged, then closed for idempotent create path.
		const states: Array<"open" | "closed" | "merged" | "all"> =
			requested === "all" ? ["open", "merged", "closed"] : [requested];

		for (const s of states) {
			const r = this.#invoke([
				"pr",
				"list",
				...repoFlag(request.repository),
				"--head",
				request.headBranch,
				"--base",
				request.baseBranch,
				"--state",
				s,
				"--limit",
				"20",
				"--json",
				PR_IDENTITY_JSON,
			]);
			if (r.status !== 0) {
				adapterError("gh pr list failed", {
					status: r.status,
					stderr: redactText(r.stderr.trim()).slice(0, 500),
				});
			}
			let items: ReturnType<typeof parsePrList>;
			try {
				const raw = r.stdout.trim().length === 0 ? "[]" : r.stdout;
				items = parsePrList(parseJsonStdout(raw));
			} catch (e) {
				adapterError(e instanceof Error ? e.message : "invalid pr list JSON", {
					stderr: redactText(r.stderr).slice(0, 300),
				});
			}
			const match = items.find(
				(p) => p.headRefName === request.headBranch && p.baseRefName === request.baseBranch,
			);
			if (match) {
				return {
					repository: request.repository,
					number: match.number,
					url: match.url,
					originalHeadSha: match.headRefOid.toLowerCase(),
					headBranch: match.headRefName,
					baseBranch: match.baseRefName,
				};
			}
		}
		return null;
	}

	async createPullRequest(request: CreatePullRequestRequest): Promise<PullRequestIdentity> {
		assertRepo(request.repository);
		if (!request.headBranch || !request.baseBranch) {
			validationError("headBranch and baseBranch are required");
		}
		if (!request.title.trim()) {
			validationError("title is required");
		}

		// gh pr create does not support --json; it prints the PR URL on success.
		// Identity is then loaded via pr view --json (machine-readable).
		const created = this.#invoke([
			"pr",
			"create",
			...repoFlag(request.repository),
			"--head",
			request.headBranch,
			"--base",
			request.baseBranch,
			"--title",
			request.title,
			"--body",
			request.body ?? "",
		]);
		if (created.status !== 0) {
			adapterError("gh pr create failed", {
				status: created.status,
				stderr: redactText(created.stderr.trim()).slice(0, 500),
			});
		}

		const urlLine = created.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
		const numberFromUrl = urlLine.match(/\/pull\/(\d+)\s*$/)?.[1];
		const viewArg = numberFromUrl ?? request.headBranch;

		const r = this.#invoke([
			"pr",
			"view",
			viewArg,
			...repoFlag(request.repository),
			"--json",
			PR_IDENTITY_JSON,
		]);
		if (r.status !== 0) {
			adapterError("gh pr view after create failed", {
				status: r.status,
				stderr: redactText(r.stderr.trim()).slice(0, 500),
			});
		}
		let view: ReturnType<typeof parsePrListItem>;
		try {
			view = parsePrListItem(parseJsonStdout(r.stdout));
		} catch (e) {
			adapterError(e instanceof Error ? e.message : "invalid pr create/view JSON", {
				stdout: redactText(r.stdout).slice(0, 200),
			});
		}
		return {
			repository: request.repository,
			number: view.number,
			url: view.url,
			originalHeadSha: view.headRefOid.toLowerCase(),
			headBranch: view.headRefName,
			baseBranch: view.baseRefName,
		};
	}

	async getPullRequestStatus(request: GetPullRequestStatusRequest): Promise<PullRequestStatus> {
		assertRepo(request.repository);
		if (!Number.isInteger(request.number) || request.number <= 0) {
			validationError("PR number must be a positive integer");
		}

		const r = this.#invoke([
			"pr",
			"view",
			String(request.number),
			...repoFlag(request.repository),
			"--json",
			PR_STATUS_JSON,
		]);
		if (r.status !== 0) {
			adapterError("gh pr view failed", {
				status: r.status,
				stderr: redactText(r.stderr.trim()).slice(0, 500),
			});
		}
		try {
			const view = parsePrView(parseJsonStdout(r.stdout));
			return normalizePullRequestStatus(view, request.repository);
		} catch (e) {
			adapterError(e instanceof Error ? e.message : "invalid pr view JSON", {
				stdout: redactText(r.stdout).slice(0, 200),
			});
		}
	}
}
