/**
 * RED: project registration service — validation, uniqueness, protected fields,
 * archival, redaction, transactional audit.
 *
 * Fails until project-service is implemented.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AutopilotRunner,
	RuntimeValidation,
	TaskValidation,
} from "../../../autopilot/src/index";
import {
	applyCoreMigration,
	applyWorkflowMigration,
	countActiveAttemptsForProject,
	createAdminAccount,
	createDatabaseClient,
	createDatabaseFixture,
	createDevelopmentAttempt,
	createTaskApproval,
	createWorkspace,
	DATABASE_URL,
	type DatabaseClient,
	type DatabaseFixture,
	getProjectById,
	listAuditEventsForTarget,
	resetSchema,
	type Sql,
} from "../../../database/src/index";
import type {
	GitGateway,
	GitPreflightRequest,
	GitPreflightResult,
	RepositoryIdentityView,
} from "../../../git/src/index";
import type {
	GitHubGateway,
	ValidateAccessRequest,
	ValidateAccessResult,
} from "../../../github/src/index";
import {
	createProjectService,
	type ProjectService,
	type ProjectValidationResult,
} from "./project-service";

let client: DatabaseClient;
let sql: Sql;
let fixture: DatabaseFixture;
let workspaceRoot: string;
let projectDir: string;
let workspaceId: string;

function okPreflight(
	request: GitPreflightRequest,
	overrides: Partial<GitPreflightResult> = {},
): GitPreflightResult {
	const repository: RepositoryIdentityView = {
		owner: request.expectedRepository.owner,
		repository: request.expectedRepository.repository,
		fullName: request.expectedRepository.fullName,
	};
	return {
		ok: true,
		projectRoot: request.projectRoot,
		remoteName: request.remoteName,
		remoteUrl: `https://github.com/${repository.fullName}.git`,
		repository,
		developmentBranch: request.developmentBranch,
		featureBranch: request.featureBranch,
		headBranch: request.developmentBranch,
		headSha: "abc123",
		failures: [],
		...overrides,
	};
}

function createFakeGit(
	options: {
		preflight?: (req: GitPreflightRequest) => Promise<GitPreflightResult> | GitPreflightResult;
	} = {},
): GitGateway {
	return {
		async preflight(request) {
			if (options.preflight) return options.preflight(request);
			return okPreflight(request);
		},
		async ensureFeatureBranch() {
			throw new Error("ensureFeatureBranch not used in project registration");
		},
		async observeCommits() {
			return [];
		},
		async pushFeatureBranch() {
			throw new Error("pushFeatureBranch not used in project registration");
		},
	};
}

function createFakeGithub(
	options: {
		validateAccess?: (
			req: ValidateAccessRequest,
		) => Promise<ValidateAccessResult> | ValidateAccessResult;
	} = {},
): GitHubGateway {
	return {
		async validateAuthentication() {
			return { ok: true, authenticated: true, login: "owner" };
		},
		async validateAccess(request) {
			if (options.validateAccess) return options.validateAccess(request);
			return {
				ok: true,
				authenticated: true,
				login: "owner",
				repositoryReadable: true,
				pushFeasible: true,
				failures: [],
			};
		},
		async findExistingPullRequest() {
			return null;
		},
		async createPullRequest() {
			throw new Error("createPullRequest not used in project registration");
		},
		async getPullRequestStatus() {
			throw new Error("getPullRequestStatus not used in project registration");
		},
	};
}

function createFakeAutopilot(
	options: { runtime?: RuntimeValidation; task?: TaskValidation } = {},
): AutopilotRunner {
	return {
		async validateRuntime() {
			return (
				options.runtime ?? { ok: true, message: "ok", executablePath: "/usr/bin/autopilotagent" }
			);
		},
		async validateTask() {
			return options.task ?? { ok: true, message: "ok", checksum: "deadbeef" };
		},
		async start() {
			throw new Error("start not used");
		},
		async isAlive() {
			return false;
		},
		async signal() {},
		async wait() {
			throw new Error("wait not used");
		},
		async readProgress() {
			throw new Error("readProgress not used");
		},
		async observeCommits() {
			return [];
		},
	};
}

function makeService(
	overrides: {
		git?: GitGateway;
		github?: GitHubGateway;
		autopilot?: AutopilotRunner;
		now?: () => Date;
	} = {},
): ProjectService {
	return createProjectService({
		sql,
		workspaceRoots: [workspaceRoot],
		git: overrides.git ?? createFakeGit(),
		github: overrides.github ?? createFakeGithub(),
		autopilot: overrides.autopilot ?? createFakeAutopilot(),
		now: overrides.now ?? (() => new Date("2026-07-18T12:00:00.000Z")),
	});
}

const ACTOR = { actorType: "administrator" as const, actorId: "admin-1" };

async function seedActiveJob(projectId: string): Promise<void> {
	const feature = await fixture.featureInProject(
		projectId,
		`job-${crypto.randomUUID().slice(0, 6)}`,
	);
	const admin = await createAdminAccount(sql, {
		username: `a-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$seed",
	});
	const approval = await createTaskApproval(sql, {
		projectId,
		featureId: feature.id,
		relativeTaskPath: "docs/tasks/f.json",
		checksum: "sha256:x",
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [] },
		approvedByAdminId: admin.id,
	});
	await createDevelopmentAttempt(sql, {
		projectId,
		featureId: feature.id,
		taskApprovalId: approval.id,
		branchName: feature.branchName,
		operationKey: `op-${crypto.randomUUID()}`,
		status: "QUEUED",
	});
}

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await resetSchema(sql);
	await applyCoreMigration(sql);
	await applyWorkflowMigration(sql);

	workspaceRoot = await mkdtemp(join(tmpdir(), "ac-ws-"));
	projectDir = join(workspaceRoot, "demo-app");
	await mkdir(projectDir, { recursive: true });
	// ensure realpath works
	workspaceRoot = await realpath(workspaceRoot);
	projectDir = await realpath(projectDir);
});

afterAll(async () => {
	await client.end();
	await rm(workspaceRoot, { recursive: true, force: true });
});

beforeEach(async () => {
	await sql.unsafe(`
		TRUNCATE TABLE
			outbox_intents,
			scheduled_reconciliation_jobs,
			idempotency_records,
			diagnostic_log_chunks,
			progress_snapshots,
			failure_records,
			activity_events,
			audit_events,
			development_job_attempts,
			worker_registrations,
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
	fixture = createDatabaseFixture(sql);
	const workspace = await createWorkspace(sql);
	workspaceId = workspace.id;
});

describe("project validation aggregate", () => {
	test("returns structured checks for path, git, remote, branch, autopilot, gh auth, access, push", async () => {
		const service = makeService();
		const result = await service.validateProject({
			name: "Demo",
			slug: "demo",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
		});

		expect(result.ok).toBe(true);
		expect(result.canonicalPath).toBe(projectDir);
		const codes = result.checks.map((c) => c.code);
		expect(codes).toEqual([
			"ROOT_CONTAINMENT",
			"GIT_REPOSITORY",
			"REMOTE_IDENTITY",
			"DEVELOPMENT_BRANCH",
			"AUTOPILOT_RUNTIME",
			"GH_AUTHENTICATION",
			"REPOSITORY_ACCESS",
			"PUSH_FEASIBILITY",
		]);
		for (const check of result.checks) {
			expect(check.ok).toBe(true);
			// no credential-bearing fields
			expect(JSON.stringify(check)).not.toMatch(/ghp_|Bearer |password=/i);
		}
	});

	test("reports each failing check independently without credentials", async () => {
		const service = makeService({
			git: createFakeGit({
				preflight: (req) =>
					okPreflight(req, {
						ok: false,
						failures: [
							{ code: "NOT_A_GIT_REPOSITORY", message: "not a git repo" },
							{ code: "REMOTE_IDENTITY_MISMATCH", message: "remote mismatch" },
							{ code: "DEVELOPMENT_BRANCH_MISSING", message: "branch missing" },
						],
					}),
			}),
			github: createFakeGithub({
				validateAccess: () => ({
					ok: false,
					authenticated: false,
					login: null,
					repositoryReadable: false,
					pushFeasible: false,
					failures: [
						{
							code: "NOT_AUTHENTICATED",
							message: "gh auth status failed token=ghp_SECRETTOKEN1234567890",
						},
						{ code: "REPO_INACCESSIBLE", message: "cannot read" },
						{ code: "PUSH_NOT_FEASIBLE", message: "no push" },
					],
				}),
			}),
			autopilot: createFakeAutopilot({
				runtime: { ok: false, message: "autopilotagent missing" },
			}),
		});

		const result = await service.validateProject({
			name: "Demo",
			slug: "demo",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
		});

		expect(result.ok).toBe(false);
		const byCode = Object.fromEntries(result.checks.map((c) => [c.code, c]));
		expect(byCode.GIT_REPOSITORY?.ok).toBe(false);
		expect(byCode.REMOTE_IDENTITY?.ok).toBe(false);
		expect(byCode.DEVELOPMENT_BRANCH?.ok).toBe(false);
		expect(byCode.AUTOPILOT_RUNTIME?.ok).toBe(false);
		expect(byCode.GH_AUTHENTICATION?.ok).toBe(false);
		expect(byCode.REPOSITORY_ACCESS?.ok).toBe(false);
		expect(byCode.PUSH_FEASIBILITY?.ok).toBe(false);
		const blob = JSON.stringify(result);
		expect(blob).not.toContain("ghp_SECRETTOKEN");
		expect(blob).not.toMatch(/token=ghp_/i);
	});

	test("rejects path outside workspace roots", async () => {
		const service = makeService();
		const outside = await mkdtemp(join(tmpdir(), "ac-out-"));
		try {
			const result = await service.validateProject({
				name: "Demo",
				slug: "demo",
				githubOwner: "acme",
				githubRepo: "demo-app",
				workspacePath: outside,
				developmentBranch: "main",
			});
			expect(result.ok).toBe(false);
			const root = result.checks.find((c) => c.code === "ROOT_CONTAINMENT");
			expect(root?.ok).toBe(false);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("project create", () => {
	test("saves project only when every validation check passes", async () => {
		const service = makeService({
			autopilot: createFakeAutopilot({
				runtime: { ok: false, message: "missing" },
			}),
		});
		const rejected = await service.createProject({
			workspaceId,
			name: "Demo",
			slug: "demo",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("expected reject");
		expect(rejected.reason).toBe("VALIDATION_FAILED");
		const empty = await sql`SELECT count(*)::int AS n FROM projects`;
		expect(Number(empty[0]?.n ?? -1)).toBe(0);

		// rejection audited
		const audits = await sql`SELECT * FROM audit_events WHERE action = 'project.create'`;
		expect(audits.length).toBe(1);
		expect(audits[0]?.result).toBe("rejected");
	});

	test("creates project with uniqueness on path name slug github and emits success audit", async () => {
		const service = makeService();
		const created = await service.createProject({
			workspaceId,
			name: "Demo App",
			slug: "demo-app",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
			description: "hello",
			actor: ACTOR,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("expected ok");
		expect(created.project.canonicalPath).toBe(projectDir);
		expect(created.project.slug).toBe("demo-app");
		expect(created.project.validationStatus).toBe("passed");
		expect(created.project.status).toBe("active");
		expect(created.validation.ok).toBe(true);

		const audits = await listAuditEventsForTarget(sql, {
			targetType: "project",
			targetId: created.project.id,
		});
		expect(audits.some((a) => a.action === "project.create" && a.result === "success")).toBe(true);
		expect(JSON.stringify(audits)).not.toMatch(/ghp_|password|Bearer /i);

		// duplicate path rejected
		const otherDir = join(workspaceRoot, "other");
		await mkdir(otherDir);
		// symlink alias to same realpath
		const alias = join(workspaceRoot, "alias-demo");
		await symlink(projectDir, alias);

		const dupPath = await service.createProject({
			workspaceId,
			name: "Other",
			slug: "other",
			githubOwner: "acme",
			githubRepo: "other",
			workspacePath: alias,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(dupPath.ok).toBe(false);
		if (dupPath.ok) throw new Error("expected fail");
		expect(dupPath.reason).toBe("UNIQUENESS_VIOLATION");

		const dupSlug = await service.createProject({
			workspaceId,
			name: "Other Name",
			slug: "demo-app",
			githubOwner: "acme",
			githubRepo: "other2",
			workspacePath: otherDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(dupSlug.ok).toBe(false);
		if (dupSlug.ok) throw new Error("expected fail");
		expect(dupSlug.reason).toBe("UNIQUENESS_VIOLATION");
	});

	test("rolls back project insert when audit write fails", async () => {
		// force audit failure mid-transaction via sql proxy
		const brokenSql = new Proxy(sql, {
			apply(target, thisArg, argArray) {
				return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, argArray);
			},
			get(target, prop, receiver) {
				if (prop === "begin") {
					return async (fn: (tx: Sql) => Promise<unknown>) => {
						return (target as Sql).begin(async (tx) => {
							const wrapped = new Proxy(tx, {
								apply(t, thisArg, args) {
									const first = String(args[0]?.[0] ?? args[0] ?? "");
									if (first.includes("INSERT INTO audit_events")) {
										throw new Error("forced audit failure");
									}
									return Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args);
								},
								get(t, p, r) {
									const v = Reflect.get(t, p, r);
									return typeof v === "function" ? v.bind(t) : v;
								},
							}) as unknown as Sql;
							return fn(wrapped);
						});
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Sql;

		const broken = createProjectService({
			sql: brokenSql,
			workspaceRoots: [workspaceRoot],
			git: createFakeGit(),
			github: createFakeGithub(),
			autopilot: createFakeAutopilot(),
			now: () => new Date("2026-07-18T12:00:00.000Z"),
		});

		await expect(
			broken.createProject({
				workspaceId,
				name: "Rollback",
				slug: "rollback",
				githubOwner: "acme",
				githubRepo: "rollback",
				workspacePath: projectDir,
				developmentBranch: "main",
				actor: ACTOR,
			}),
		).rejects.toThrow(/forced audit failure/);

		const projects = await sql`SELECT * FROM projects`;
		expect(projects.length).toBe(0);
	});
});

describe("project update protection", () => {
	test("blocks path, repository, and development-branch changes when jobs are active", async () => {
		const service = makeService();
		const created = await service.createProject({
			workspaceId,
			name: "Demo",
			slug: "demo",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");
		await seedActiveJob(created.project.id);
		expect(await countActiveAttemptsForProject(sql, created.project.id)).toBe(1);

		const altDir = join(workspaceRoot, "alt");
		await mkdir(altDir, { recursive: true });

		const pathChange = await service.updateProject({
			projectId: created.project.id,
			workspacePath: altDir,
			actor: ACTOR,
		});
		expect(pathChange.ok).toBe(false);
		if (pathChange.ok) throw new Error("expected fail");
		expect(pathChange.reason).toBe("ACTIVE_JOBS");

		const repoChange = await service.updateProject({
			projectId: created.project.id,
			githubOwner: "other",
			githubRepo: "repo",
			actor: ACTOR,
		});
		expect(repoChange.ok).toBe(false);
		if (repoChange.ok) throw new Error("expected fail");
		expect(repoChange.reason).toBe("ACTIVE_JOBS");

		const branchChange = await service.updateProject({
			projectId: created.project.id,
			developmentBranch: "develop",
			actor: ACTOR,
		});
		expect(branchChange.ok).toBe(false);
		if (branchChange.ok) throw new Error("expected fail");
		expect(branchChange.reason).toBe("ACTIVE_JOBS");

		// safe field still ok
		const nameChange = await service.updateProject({
			projectId: created.project.id,
			name: "Demo Renamed",
			description: "safe",
			actor: ACTOR,
		});
		expect(nameChange.ok).toBe(true);
		if (!nameChange.ok) throw new Error("expected ok");
		expect(nameChange.project.name).toBe("Demo Renamed");
	});

	test("allows protected field changes when no active jobs and revalidates", async () => {
		const service = makeService();
		const created = await service.createProject({
			workspaceId,
			name: "Demo",
			slug: "demo",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		const altDir = join(workspaceRoot, "alt2");
		await mkdir(altDir, { recursive: true });

		const updated = await service.updateProject({
			projectId: created.project.id,
			workspacePath: altDir,
			developmentBranch: "develop",
			githubOwner: "acme",
			githubRepo: "demo-app",
			actor: ACTOR,
		});
		expect(updated.ok).toBe(true);
		if (!updated.ok) throw new Error("expected ok");
		expect(updated.project.canonicalPath).toBe(await realpath(altDir));
		expect(updated.project.developmentBranch).toBe("develop");
		expect(updated.validation?.ok).toBe(true);

		const audits = await listAuditEventsForTarget(sql, {
			targetType: "project",
			targetId: created.project.id,
		});
		expect(audits.some((a) => a.action === "project.update" && a.result === "success")).toBe(true);
	});
});

describe("project archive", () => {
	test("archives without deleting history or checkout and blocks when jobs active", async () => {
		const service = makeService();
		const created = await service.createProject({
			workspaceId,
			name: "Demo",
			slug: "demo",
			githubOwner: "acme",
			githubRepo: "demo-app",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");

		// seed release/feature/pr-ish history via fixture helpers
		const release = await fixture.featureInProject(created.project.id, "hist");
		expect(release.projectId).toBe(created.project.id);

		await seedActiveJob(created.project.id);
		const blocked = await service.archiveProject({
			projectId: created.project.id,
			actor: ACTOR,
		});
		expect(blocked.ok).toBe(false);
		if (blocked.ok) throw new Error("expected fail");
		expect(blocked.reason).toBe("ACTIVE_JOBS");

		// clear active jobs
		await sql`UPDATE development_job_attempts SET status = 'CANCELLED', ended_at = now()`;

		const archived = await service.archiveProject({
			projectId: created.project.id,
			actor: ACTOR,
		});
		expect(archived.ok).toBe(true);
		if (!archived.ok) throw new Error("expected ok");
		expect(archived.project.status).toBe("archived");
		expect(archived.project.archivedAt).toBeTruthy();

		// history still queryable
		const features = await sql`SELECT * FROM features WHERE project_id = ${created.project.id}`;
		expect(features.length).toBeGreaterThan(0);
		const loaded = await getProjectById(sql, created.project.id);
		expect(loaded?.status).toBe("archived");

		// checkout still on disk
		const st = await Bun.file(join(projectDir, "."))
			.exists()
			.catch(() => false);
		// directory exists via realpath
		expect(await realpath(projectDir)).toBe(projectDir);

		const audits = await listAuditEventsForTarget(sql, {
			targetType: "project",
			targetId: created.project.id,
		});
		expect(audits.some((a) => a.action === "project.archive" && a.result === "success")).toBe(true);

		// re-register same path after archive allowed
		const recreated = await service.createProject({
			workspaceId,
			name: "Demo 2",
			slug: "demo-2",
			githubOwner: "acme",
			githubRepo: "demo-app-2",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(recreated.ok).toBe(true);

		// silence unused
		void st;
	});
});

describe("validation result type export", () => {
	test("ProjectValidationResult shape is exported", () => {
		const sample: ProjectValidationResult = {
			ok: false,
			canonicalPath: null,
			checks: [],
		};
		expect(sample.ok).toBe(false);
	});
});

describe("requirement 47 project coverage edges", () => {
	test("reports indeterminate validation details and gateway exceptions", async () => {
		const defaultClockService = createProjectService({
			sql,
			workspaceRoots: [workspaceRoot],
			git: createFakeGit(),
			github: createFakeGithub(),
			autopilot: createFakeAutopilot(),
		});
		const defaultClockValidation = await defaultClockService.validateProject({
			name: "Default clock",
			slug: "default-clock",
			githubOwner: "acme",
			githubRepo: "default-clock",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(defaultClockValidation.ok).toBe(true);

		const unrelatedFailure = makeService({
			git: createFakeGit({
				preflight: (request) =>
					okPreflight(request, {
						ok: false,
						failures: [{ code: "DIRTY_WORKTREE", message: "dirty" }],
					}),
			}),
			github: createFakeGithub({
				validateAccess: () => ({
					ok: false,
					authenticated: true,
					login: null,
					repositoryReadable: true,
					pushFeasible: null,
					failures: [],
				}),
			}),
			autopilot: createFakeAutopilot({ runtime: { ok: false, message: "" } }),
		});
		const indeterminate = await unrelatedFailure.validateProject({
			name: "Indeterminate",
			slug: "indeterminate",
			githubOwner: "acme",
			githubRepo: "indeterminate",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(indeterminate.ok).toBe(false);
		expect(indeterminate.checks.find((item) => item.code === "GIT_REPOSITORY")?.message).toBe(
			"Path is not a Git worktree",
		);
		expect(indeterminate.checks.find((item) => item.code === "AUTOPILOT_RUNTIME")?.message).toBe(
			"Autopilot runtime unavailable",
		);
		expect(indeterminate.checks.find((item) => item.code === "PUSH_FEASIBILITY")?.message).toBe(
			"Push feasibility could not be determined",
		);

		const throwing = makeService({
			autopilot: {
				...createFakeAutopilot(),
				async validateRuntime() {
					throw "runtime unavailable";
				},
			},
			github: createFakeGithub({
				validateAccess: async () => {
					throw "github unavailable";
				},
			}),
		});
		const failed = await throwing.validateProject({
			name: "Throwing gateways",
			slug: "throwing-gateways",
			githubOwner: "acme",
			githubRepo: "throwing-gateways",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(failed.ok).toBe(false);
		expect(failed.checks.find((item) => item.code === "AUTOPILOT_RUNTIME")?.message).toBe(
			"Autopilot runtime check failed",
		);
		expect(failed.checks.find((item) => item.code === "GH_AUTHENTICATION")?.message).toBe(
			"GitHub access check failed",
		);
	});

	test("rejects each active-project uniqueness key", async () => {
		const service = makeService();
		const created = await service.createProject({
			workspaceId,
			name: "Unique Base",
			slug: "unique-base",
			githubOwner: "acme",
			githubRepo: "unique-base",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		if (!created.ok) throw new Error("create failed");
		const otherDir = join(workspaceRoot, `unique-${crypto.randomUUID()}`);
		await mkdir(otherDir, { recursive: true });

		const duplicateName = await service.createProject({
			workspaceId,
			name: "Unique Base",
			slug: "another-slug",
			githubOwner: "acme",
			githubRepo: "another-repo",
			workspacePath: otherDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(duplicateName.ok).toBe(false);

		const duplicateGithub = await service.createProject({
			workspaceId,
			name: "Another Name",
			slug: "another-project",
			githubOwner: "acme",
			githubRepo: "unique-base",
			workspacePath: otherDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(duplicateGithub.ok).toBe(false);
	});

	test("rejects archived updates and invalid or conflicting protected updates", async () => {
		const service = makeService();
		const first = await service.createProject({
			workspaceId,
			name: "First",
			slug: "first",
			githubOwner: "acme",
			githubRepo: "first",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		if (!first.ok) throw new Error("create failed");
		const secondDir = join(workspaceRoot, `second-${crypto.randomUUID()}`);
		await mkdir(secondDir, { recursive: true });
		const second = await service.createProject({
			workspaceId,
			name: "Second",
			slug: "second",
			githubOwner: "acme",
			githubRepo: "second",
			workspacePath: secondDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		if (!second.ok) throw new Error("create failed");

		const invalidIdentity = await service.updateProject({
			projectId: first.project.id,
			githubOwner: " ",
			actor: ACTOR,
		});
		expect(invalidIdentity.ok).toBe(false);
		const invalidPath = await service.updateProject({
			projectId: first.project.id,
			workspacePath: "/outside/allowlist",
			actor: ACTOR,
		});
		expect(invalidPath.ok).toBe(false);
		const conflictingName = await service.updateProject({
			projectId: first.project.id,
			name: second.project.name,
			actor: ACTOR,
		});
		expect(conflictingName.ok).toBe(false);

		const archived = await service.archiveProject({ projectId: first.project.id, actor: ACTOR });
		expect(archived.ok).toBe(true);
		const updateArchived = await service.updateProject({
			projectId: first.project.id,
			name: "No longer active",
			actor: ACTOR,
		});
		expect(updateArchived.ok).toBe(false);
		if (!updateArchived.ok) expect(updateArchived.reason).toBe("ALREADY_ARCHIVED");
		const archiveAgain = await service.archiveProject({
			projectId: first.project.id,
			actor: ACTOR,
		});
		expect(archiveAgain.ok).toBe(false);
	});

	test("validate rejects invalid repository identity and empty workspace roots path", async () => {
		const service = makeService();
		const invalidRepo = await service.validateProject({
			name: "Bad Repo",
			slug: "bad-repo",
			githubOwner: " ",
			githubRepo: "",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(invalidRepo.ok).toBe(false);

		const emptyPath = await service.validateProject({
			name: "Empty Path",
			slug: "empty-path",
			githubOwner: "acme",
			githubRepo: "empty",
			workspacePath: "   ",
			developmentBranch: "main",
		});
		expect(emptyPath.ok).toBe(false);
	});

	test("createProject fails validation for invalid github identity", async () => {
		const service = makeService();
		const result = await service.createProject({
			workspaceId,
			name: "Invalid GH",
			slug: "invalid-gh",
			githubOwner: "",
			githubRepo: "repo",
			workspacePath: projectDir,
			developmentBranch: "main",
			actor: ACTOR,
		});
		expect(result.ok).toBe(false);
	});

	test("updateProject rejects missing project and archive of missing project", async () => {
		const service = makeService();
		const missing = await service.updateProject({
			projectId: crypto.randomUUID(),
			name: "Nope",
			actor: ACTOR,
		});
		expect(missing.ok).toBe(false);
		const archiveMissing = await service.archiveProject({
			projectId: crypto.randomUUID(),
			actor: ACTOR,
		});
		expect(archiveMissing.ok).toBe(false);
	});

	test("git preflight throw is reported as failed checks", async () => {
		const service = createProjectService({
			sql,
			workspaceRoots: [projectDir],
			git: {
				async preflight() {
					throw new Error("boom preflight");
				},
				async ensureFeatureBranch() {
					throw new Error("unused");
				},
				async observeCommits() {
					return [];
				},
				async pushFeatureBranch() {
					throw new Error("unused");
				},
			},
			github: {
				async validateAuthentication() {
					return { ok: true, authenticated: true, login: "x" };
				},
				async validateAccess() {
					return {
						ok: true,
						authenticated: true,
						login: "x",
						repositoryReadable: true,
						pushFeasible: true,
						failures: [],
					};
				},
				async findExistingPullRequest() {
					return null;
				},
				async createPullRequest() {
					throw new Error("unused");
				},
				async getPullRequestStatus() {
					throw new Error("unused");
				},
			},
			autopilot: {
				async validateRuntime() {
					return { ok: true, message: "ok", executablePath: "/bin/true" };
				},
				async validateTask() {
					return { ok: true, message: "ok", checksum: "x" };
				},
				async start() {
					throw new Error("unused");
				},
				async isAlive() {
					return false;
				},
				async signal() {},
				async wait() {
					throw new Error("unused");
				},
				async readProgress() {
					return {
						total: 0,
						passed: 0,
						stuck: 0,
						invalidTest: 0,
						remaining: 0,
						allPass: false,
						blockedReasons: [],
					};
				},
				async observeCommits() {
					return [];
				},
			},
			now: () => new Date("2026-07-18T12:00:00.000Z"),
		});
		const result = await service.validateProject({
			name: "Throwing Git",
			slug: "throwing-git",
			githubOwner: "acme",
			githubRepo: "throw",
			workspacePath: projectDir,
			developmentBranch: "main",
		});
		expect(result.ok).toBe(false);
		expect(result.checks.some((c) => !c.ok && c.message.includes("boom"))).toBe(true);
	});
});
