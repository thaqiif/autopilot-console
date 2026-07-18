/**
 * Transactional project registration, validation, update, and archival (F-2).
 */

import type { AutopilotRunner } from "../../../autopilot/src/index";
import type { Queryable, TransactionSql } from "../../../database/src/client";
import {
	appendAuditEvent,
	archiveProject as archiveProjectRow,
	countActiveAttemptsForProject,
	findActiveProjectByCanonicalPath,
	findActiveProjectByGithub,
	findActiveProjectByName,
	findActiveProjectBySlug,
	getProjectById,
	createProject as insertProject,
	type ProjectRow,
	updateProject as updateProjectRow,
} from "../../../database/src/index";
import type {
	GitGateway,
	GitPreflightFailureCode,
	GitPreflightResult,
} from "../../../git/src/index";
import type { GitHubGateway, ValidateAccessResult } from "../../../github/src/index";
import { canonicalizeWorkspacePath } from "../../../shared/src/fs/workspace-path";
import { sanitizeSlug } from "../../../shared/src/git/feature-branch";
import {
	normalizeRepositoryIdentity,
	type RepositoryIdentity,
} from "../../../shared/src/git/repository-identity";
import { redactSecrets, redactValue } from "../../../shared/src/security/redaction";
import type { Project, ProjectActor } from "./project";
import {
	aggregateValidationOk,
	PROJECT_VALIDATION_CHECK_CODES,
	type ProjectValidationCheck,
	type ProjectValidationCheckCode,
	type ProjectValidationInput,
	type ProjectValidationResult,
	touchesProtectedProjectFields,
} from "./project-validation";

export type { ProjectValidationResult } from "./project-validation";

export type ProjectMutationFailureReason =
	| "VALIDATION_FAILED"
	| "UNIQUENESS_VIOLATION"
	| "ACTIVE_JOBS"
	| "NOT_FOUND"
	| "ALREADY_ARCHIVED";

export type CreateProjectResult =
	| { ok: true; project: Project; validation: ProjectValidationResult }
	| {
			ok: false;
			reason: ProjectMutationFailureReason;
			validation?: ProjectValidationResult;
			message: string;
	  };

export type UpdateProjectResult =
	| {
			ok: true;
			project: Project;
			validation?: ProjectValidationResult;
	  }
	| {
			ok: false;
			reason: ProjectMutationFailureReason;
			validation?: ProjectValidationResult;
			message: string;
	  };

export type ArchiveProjectResult =
	| { ok: true; project: Project }
	| { ok: false; reason: ProjectMutationFailureReason; message: string };

export interface ProjectServiceOptions {
	sql: Queryable;
	workspaceRoots: readonly string[];
	git: GitGateway;
	github: GitHubGateway;
	autopilot: AutopilotRunner;
	remoteName?: string;
	now?: () => Date;
}

export interface ProjectService {
	validateProject(input: ProjectValidationInput): Promise<ProjectValidationResult>;
	createProject(
		input: ProjectValidationInput & {
			workspaceId: string;
			description?: string;
			actor: ProjectActor;
		},
	): Promise<CreateProjectResult>;
	updateProject(input: {
		projectId: string;
		name?: string;
		slug?: string;
		description?: string | null;
		githubOwner?: string;
		githubRepo?: string;
		workspacePath?: string;
		developmentBranch?: string;
		actor: ProjectActor;
	}): Promise<UpdateProjectResult>;
	archiveProject(input: { projectId: string; actor: ProjectActor }): Promise<ArchiveProjectResult>;
}

type TxCapable = Queryable & {
	begin?: <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;
};

function mapRow(row: ProjectRow): Project {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		slug: row.slug,
		description: row.description,
		githubOwner: row.githubOwner,
		githubRepo: row.githubRepo,
		canonicalPath: row.canonicalPath,
		developmentBranch: row.developmentBranch,
		validationStatus: row.validationStatus,
		lastValidatedAt: row.lastValidatedAt,
		status: row.status,
		archivedAt: row.archivedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function safeMessage(message: string): string {
	return redactSecrets(message).slice(0, 500);
}

function check(
	code: ProjectValidationCheckCode,
	ok: boolean,
	message: string,
): ProjectValidationCheck {
	return { code, ok, message: safeMessage(message) };
}

function preflightHas(result: GitPreflightResult, codes: GitPreflightFailureCode[]): boolean {
	return result.failures.some((f) => codes.includes(f.code));
}

function preflightMessage(
	result: GitPreflightResult,
	codes: GitPreflightFailureCode[],
	fallbackOk: string,
	fallbackFail: string,
): string {
	const hit = result.failures.find((f) => codes.includes(f.code));
	if (hit) return hit.message;
	return result.ok || !codes.length ? fallbackOk : fallbackFail;
}

async function runValidation(
	options: ProjectServiceOptions,
	input: ProjectValidationInput,
): Promise<ProjectValidationResult> {
	const checks: ProjectValidationCheck[] = [];
	let canonicalPath: string | null = null;

	// 1. Root containment
	try {
		canonicalPath = await canonicalizeWorkspacePath(input.workspacePath, options.workspaceRoots);
		checks.push(check("ROOT_CONTAINMENT", true, "Path is inside allowlisted roots"));
	} catch (err) {
		const message = err instanceof Error ? err.message : "Path validation failed";
		checks.push(check("ROOT_CONTAINMENT", false, message));
		// Remaining checks still run where possible with the raw path.
		canonicalPath = null;
	}

	let repository: RepositoryIdentity;
	try {
		repository = normalizeRepositoryIdentity({
			owner: input.githubOwner,
			repository: input.githubRepo,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid repository identity";
		// Force remote identity fail and skip git/github with empty identity.
		repository = {
			owner: input.githubOwner.trim() || "invalid",
			repository: input.githubRepo.trim() || "invalid",
			fullName: `${input.githubOwner}/${input.githubRepo}`,
		};
		checks.push(check("REMOTE_IDENTITY", false, message));
	}

	const projectRoot = canonicalPath ?? input.workspacePath.trim();
	const remoteName = options.remoteName ?? "origin";
	const developmentBranch = input.developmentBranch.trim();

	// 2-4. Git preflight (repo, remote, branch). Feature branch is a dummy for registration.
	let preflight: GitPreflightResult | null = null;
	if (projectRoot.length > 0) {
		try {
			preflight = await options.git.preflight({
				projectRoot,
				remoteName,
				expectedRepository: {
					owner: repository.owner,
					repository: repository.repository,
					fullName: repository.fullName,
				},
				developmentBranch,
				// Registration does not require an existing feature branch.
				featureBranch: "feature/registration-check",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Git preflight failed";
			checks.push(check("GIT_REPOSITORY", false, message));
			checks.push(check("REMOTE_IDENTITY", false, message));
			checks.push(check("DEVELOPMENT_BRANCH", false, message));
			preflight = null;
		}
	} else {
		checks.push(check("GIT_REPOSITORY", false, "Project root unavailable"));
		checks.push(check("REMOTE_IDENTITY", false, "Project root unavailable"));
		checks.push(check("DEVELOPMENT_BRANCH", false, "Project root unavailable"));
	}

	if (preflight) {
		const gitOk = !preflightHas(preflight, ["NOT_A_GIT_REPOSITORY", "PATH_INVALID"]);
		checks.push(
			check(
				"GIT_REPOSITORY",
				gitOk,
				preflightMessage(
					preflight,
					["NOT_A_GIT_REPOSITORY", "PATH_INVALID"],
					"Path is a Git worktree",
					"Path is not a Git worktree",
				),
			),
		);

		// REMOTE_IDENTITY may already have been marked for invalid owner/repo
		const alreadyRemote = checks.some((c) => c.code === "REMOTE_IDENTITY");
		if (!alreadyRemote) {
			const remoteFail = preflightHas(preflight, ["REMOTE_MISSING", "REMOTE_IDENTITY_MISMATCH"]);
			checks.push(
				check(
					"REMOTE_IDENTITY",
					!remoteFail,
					preflightMessage(
						preflight,
						["REMOTE_MISSING", "REMOTE_IDENTITY_MISMATCH"],
						`Remote matches ${repository.fullName}`,
						"Remote identity mismatch",
					),
				),
			);
		}

		const branchFail = preflightHas(preflight, ["DEVELOPMENT_BRANCH_MISSING"]);
		checks.push(
			check(
				"DEVELOPMENT_BRANCH",
				!branchFail,
				preflightMessage(
					preflight,
					["DEVELOPMENT_BRANCH_MISSING"],
					`Development branch ${developmentBranch} present`,
					"Development branch missing on remote",
				),
			),
		);
	}

	// 5. Autopilot runtime
	try {
		const runtime = await options.autopilot.validateRuntime();
		checks.push(
			check(
				"AUTOPILOT_RUNTIME",
				runtime.ok,
				runtime.ok
					? "Autopilot runtime available"
					: runtime.message || "Autopilot runtime unavailable",
			),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Autopilot runtime check failed";
		checks.push(check("AUTOPILOT_RUNTIME", false, message));
	}

	// 6-8. GitHub auth / access / push
	let access: ValidateAccessResult | null = null;
	try {
		access = await options.github.validateAccess({
			repository: {
				owner: repository.owner,
				repository: repository.repository,
				fullName: repository.fullName,
			},
			projectRoot: projectRoot || undefined,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "GitHub access check failed";
		checks.push(check("GH_AUTHENTICATION", false, message));
		checks.push(check("REPOSITORY_ACCESS", false, message));
		checks.push(check("PUSH_FEASIBILITY", false, message));
		access = null;
	}

	if (access) {
		checks.push(
			check(
				"GH_AUTHENTICATION",
				access.authenticated,
				access.authenticated
					? `Authenticated as ${access.login ?? "user"}`
					: "GitHub CLI is not authenticated",
			),
		);
		checks.push(
			check(
				"REPOSITORY_ACCESS",
				access.repositoryReadable,
				access.repositoryReadable
					? `Repository ${repository.fullName} is readable`
					: "Repository is not readable",
			),
		);
		const pushOk = access.pushFeasible === true;
		checks.push(
			check(
				"PUSH_FEASIBILITY",
				pushOk,
				pushOk
					? "Push permission appears feasible"
					: access.pushFeasible === null
						? "Push feasibility could not be determined"
						: "Push is not feasible",
			),
		);
	}

	// Ensure all codes present exactly once in order
	const byCode = new Map(checks.map((c) => [c.code, c]));
	const ordered: ProjectValidationCheck[] = PROJECT_VALIDATION_CHECK_CODES.map((code) => {
		return byCode.get(code) ?? check(code, false, "Not evaluated");
	});

	return {
		ok: aggregateValidationOk(ordered, canonicalPath),
		canonicalPath,
		checks: ordered,
	};
}

function uniquenessMessage(field: string): string {
	return `An active project already uses this ${field}`;
}

async function findUniquenessConflict(
	sql: Queryable,
	input: {
		name: string;
		slug: string;
		githubOwner: string;
		githubRepo: string;
		canonicalPath: string;
		excludeProjectId?: string;
	},
): Promise<string | null> {
	const byName = await findActiveProjectByName(sql, input.name);
	if (byName && byName.id !== input.excludeProjectId) return uniquenessMessage("name");
	const bySlug = await findActiveProjectBySlug(sql, input.slug);
	if (bySlug && bySlug.id !== input.excludeProjectId) return uniquenessMessage("slug");
	const byGithub = await findActiveProjectByGithub(sql, {
		githubOwner: input.githubOwner,
		githubRepo: input.githubRepo,
	});
	if (byGithub && byGithub.id !== input.excludeProjectId) {
		return uniquenessMessage("GitHub repository");
	}
	const byPath = await findActiveProjectByCanonicalPath(sql, input.canonicalPath);
	if (byPath && byPath.id !== input.excludeProjectId) {
		return uniquenessMessage("canonical path");
	}
	return null;
}

function isUniqueViolation(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: string; message?: string };
	return e.code === "23505" || /unique|duplicate/i.test(e.message ?? "");
}

async function withTransaction<T>(sql: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
	const capable = sql as TxCapable;
	if (typeof capable.begin === "function") {
		return capable.begin((tx) => fn(tx));
	}
	return fn(sql);
}

function projectSnapshot(project: Project): Record<string, unknown> {
	return redactValue({
		id: project.id,
		name: project.name,
		slug: project.slug,
		description: project.description,
		githubOwner: project.githubOwner,
		githubRepo: project.githubRepo,
		canonicalPath: project.canonicalPath,
		developmentBranch: project.developmentBranch,
		validationStatus: project.validationStatus,
		status: project.status,
		archivedAt: project.archivedAt?.toISOString() ?? null,
	}) as Record<string, unknown>;
}

function validationSnapshot(validation: ProjectValidationResult): Record<string, unknown> {
	return redactValue({
		ok: validation.ok,
		canonicalPath: validation.canonicalPath,
		checks: validation.checks.map((c) => ({
			code: c.code,
			ok: c.ok,
			message: c.message,
		})),
	}) as Record<string, unknown>;
}

function normalizeSlug(raw: string): string {
	// Prefer sanitizeSlug; fall back to trimmed lowercase if already valid-ish.
	try {
		return sanitizeSlug(raw);
	} catch {
		return raw.trim().toLowerCase();
	}
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
	const now = options.now ?? (() => new Date());

	return {
		async validateProject(input) {
			return runValidation(options, input);
		},

		async createProject(input) {
			const slug = normalizeSlug(input.slug);
			const name = input.name.trim();
			const developmentBranch = input.developmentBranch.trim();
			let repository: RepositoryIdentity;
			try {
				repository = normalizeRepositoryIdentity({
					owner: input.githubOwner,
					repository: input.githubRepo,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Invalid repository identity";
				const validation = await runValidation(options, { ...input, slug });
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					validation,
					message,
				};
			}

			const validation = await runValidation(options, {
				...input,
				slug,
				githubOwner: repository.owner,
				githubRepo: repository.repository,
				developmentBranch,
			});

			if (!validation.ok || !validation.canonicalPath) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "project.create",
						targetType: "project",
						targetId: "pending",
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: {
							reason: "VALIDATION_FAILED",
							validation: validationSnapshot(validation),
							name,
							slug,
							githubOwner: repository.owner,
							githubRepo: repository.repository,
						},
					});
				});
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					validation,
					message: "Project validation failed",
				};
			}

			const conflict = await findUniquenessConflict(options.sql, {
				name,
				slug,
				githubOwner: repository.owner,
				githubRepo: repository.repository,
				canonicalPath: validation.canonicalPath,
			});
			if (conflict) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "project.create",
						targetType: "project",
						targetId: "pending",
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: {
							reason: "UNIQUENESS_VIOLATION",
							message: conflict,
							name,
							slug,
						},
					});
				});
				return {
					ok: false,
					reason: "UNIQUENESS_VIOLATION",
					validation,
					message: conflict,
				};
			}

			const validatedAt = now();
			try {
				const project = await withTransaction(options.sql, async (tx) => {
					const row = await insertProject(tx, {
						workspaceId: input.workspaceId,
						name,
						slug,
						description: input.description,
						githubOwner: repository.owner,
						githubRepo: repository.repository,
						canonicalPath: validation.canonicalPath as string,
						developmentBranch,
						validationStatus: "passed",
						lastValidatedAt: validatedAt,
					});
					const mapped = mapRow(row);
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "project.create",
						targetType: "project",
						targetId: mapped.id,
						projectId: mapped.id,
						correlationId: input.actor.correlationId,
						result: "success",
						nextValues: {
							project: projectSnapshot(mapped),
							validation: validationSnapshot(validation),
						},
					});
					return mapped;
				});
				return { ok: true, project, validation };
			} catch (err) {
				if (isUniqueViolation(err)) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						validation,
						message: "An active project already uses one of these unique fields",
					};
				}
				throw err;
			}
		},

		async updateProject(input) {
			const existing = await getProjectById(options.sql, input.projectId);
			if (existing?.status !== "active") {
				return {
					ok: false,
					reason: existing ? "ALREADY_ARCHIVED" : "NOT_FOUND",
					message: existing ? "Project is archived" : "Project not found",
				};
			}

			const protectedTouched = touchesProtectedProjectFields(input);

			if (protectedTouched) {
				const active = await countActiveAttemptsForProject(options.sql, existing.id);
				if (active > 0) {
					await withTransaction(options.sql, async (tx) => {
						await appendAuditEvent(tx, {
							actorType: input.actor.actorType,
							actorId: input.actor.actorId,
							action: "project.update",
							targetType: "project",
							targetId: existing.id,
							projectId: existing.id,
							correlationId: input.actor.correlationId,
							result: "rejected",
							priorValues: projectSnapshot(mapRow(existing)),
							nextValues: { reason: "ACTIVE_JOBS", activeJobs: active },
						});
					});
					return {
						ok: false,
						reason: "ACTIVE_JOBS",
						message: "Queued or active jobs prevent protected field changes",
					};
				}
			}

			const nextName = input.name?.trim() ?? existing.name;
			const nextSlug = input.slug !== undefined ? normalizeSlug(input.slug) : existing.slug;
			const nextDescription =
				input.description !== undefined ? input.description : existing.description;
			const nextOwner = input.githubOwner ?? existing.githubOwner;
			const nextRepo = input.githubRepo ?? existing.githubRepo;
			const nextBranch = input.developmentBranch?.trim() ?? existing.developmentBranch;
			const nextPathCandidate = input.workspacePath ?? existing.canonicalPath;

			let repository: RepositoryIdentity;
			try {
				repository = normalizeRepositoryIdentity({
					owner: nextOwner,
					repository: nextRepo,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Invalid repository identity";
				return { ok: false, reason: "VALIDATION_FAILED", message };
			}

			let validation: ProjectValidationResult | undefined;
			let nextCanonicalPath = existing.canonicalPath;

			if (protectedTouched) {
				validation = await runValidation(options, {
					name: nextName,
					slug: nextSlug,
					githubOwner: repository.owner,
					githubRepo: repository.repository,
					workspacePath: nextPathCandidate,
					developmentBranch: nextBranch,
				});
				if (!validation.ok || !validation.canonicalPath) {
					await withTransaction(options.sql, async (tx) => {
						await appendAuditEvent(tx, {
							actorType: input.actor.actorType,
							actorId: input.actor.actorId,
							action: "project.update",
							targetType: "project",
							targetId: existing.id,
							projectId: existing.id,
							correlationId: input.actor.correlationId,
							result: "rejected",
							priorValues: projectSnapshot(mapRow(existing)),
							nextValues: {
								reason: "VALIDATION_FAILED",
								validation: validationSnapshot(validation as ProjectValidationResult),
							},
						});
					});
					return {
						ok: false,
						reason: "VALIDATION_FAILED",
						validation,
						message: "Project validation failed",
					};
				}
				nextCanonicalPath = validation.canonicalPath;
			}

			const conflict = await findUniquenessConflict(options.sql, {
				name: nextName,
				slug: nextSlug,
				githubOwner: repository.owner,
				githubRepo: repository.repository,
				canonicalPath: nextCanonicalPath,
				excludeProjectId: existing.id,
			});
			if (conflict) {
				return {
					ok: false,
					reason: "UNIQUENESS_VIOLATION",
					validation,
					message: conflict,
				};
			}

			const validatedAt = protectedTouched ? now() : existing.lastValidatedAt;
			try {
				const project = await withTransaction(options.sql, async (tx) => {
					const row = await updateProjectRow(tx, {
						id: existing.id,
						name: nextName,
						slug: nextSlug,
						description: nextDescription,
						githubOwner: repository.owner,
						githubRepo: repository.repository,
						canonicalPath: nextCanonicalPath,
						developmentBranch: nextBranch,
						validationStatus: protectedTouched ? "passed" : existing.validationStatus,
						lastValidatedAt: validatedAt,
					});
					const mapped = mapRow(row);
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "project.update",
						targetType: "project",
						targetId: mapped.id,
						projectId: mapped.id,
						correlationId: input.actor.correlationId,
						result: "success",
						priorValues: projectSnapshot(mapRow(existing)),
						nextValues: {
							project: projectSnapshot(mapped),
							...(validation ? { validation: validationSnapshot(validation) } : {}),
						},
					});
					return mapped;
				});
				return { ok: true, project, validation };
			} catch (err) {
				if (isUniqueViolation(err)) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						validation,
						message: "An active project already uses one of these unique fields",
					};
				}
				throw err;
			}
		},

		async archiveProject(input) {
			const existing = await getProjectById(options.sql, input.projectId);
			if (!existing) {
				return { ok: false, reason: "NOT_FOUND", message: "Project not found" };
			}
			if (existing.status !== "active") {
				return {
					ok: false,
					reason: "ALREADY_ARCHIVED",
					message: "Project is already archived",
				};
			}

			const active = await countActiveAttemptsForProject(options.sql, existing.id);
			if (active > 0) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "project.archive",
						targetType: "project",
						targetId: existing.id,
						projectId: existing.id,
						correlationId: input.actor.correlationId,
						result: "rejected",
						priorValues: projectSnapshot(mapRow(existing)),
						nextValues: { reason: "ACTIVE_JOBS", activeJobs: active },
					});
				});
				return {
					ok: false,
					reason: "ACTIVE_JOBS",
					message: "Queued or active jobs prevent archival",
				};
			}

			const archivedAt = now();
			const project = await withTransaction(options.sql, async (tx) => {
				const row = await archiveProjectRow(tx, {
					id: existing.id,
					archivedAt,
				});
				const mapped = mapRow(row);
				await appendAuditEvent(tx, {
					actorType: input.actor.actorType,
					actorId: input.actor.actorId,
					action: "project.archive",
					targetType: "project",
					targetId: mapped.id,
					projectId: mapped.id,
					correlationId: input.actor.correlationId,
					result: "success",
					priorValues: projectSnapshot(mapRow(existing)),
					nextValues: projectSnapshot(mapped),
				});
				return mapped;
			});
			return { ok: true, project };
		},
	};
}
