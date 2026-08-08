/**
 * Project integration validation check codes and aggregate result (F-2).
 */

export const PROJECT_VALIDATION_CHECK_CODES = [
	"ROOT_CONTAINMENT",
	"GIT_REPOSITORY",
	"REMOTE_IDENTITY",
	"DEVELOPMENT_BRANCH",
	"AUTOPILOT_RUNTIME",
	"GH_AUTHENTICATION",
	"REPOSITORY_ACCESS",
	"PUSH_FEASIBILITY",
] as const;

export type ProjectValidationCheckCode = (typeof PROJECT_VALIDATION_CHECK_CODES)[number];

export interface ProjectValidationCheck {
	code: ProjectValidationCheckCode;
	ok: boolean;
	/** Safe human message — never credentials or raw command dumps. */
	message: string;
}

export interface ProjectValidationResult {
	ok: boolean;
	canonicalPath: string | null;
	checks: ProjectValidationCheck[];
}

export interface ProjectValidationInput {
	name: string;
	slug: string;
	githubOwner: string;
	githubRepo: string;
	/** Absolute path candidate (not yet canonicalized). */
	workspacePath: string;
	developmentBranch: string;
}

/** Fields blocked while project has queued/active jobs. */
export const PROTECTED_PROJECT_FIELDS = [
	"workspacePath",
	"githubOwner",
	"githubRepo",
	"developmentBranch",
] as const;

export type ProtectedProjectField = (typeof PROTECTED_PROJECT_FIELDS)[number];

export interface ProjectFieldChange {
	workspacePath?: string;
	githubOwner?: string;
	githubRepo?: string;
	developmentBranch?: string;
	name?: string;
	slug?: string;
	description?: string | null;
}

/** True when any path/repo/branch field is present in the change set. */
export function touchesProtectedProjectFields(change: ProjectFieldChange): boolean {
	return (
		change.workspacePath !== undefined ||
		change.githubOwner !== undefined ||
		change.githubRepo !== undefined ||
		change.developmentBranch !== undefined
	);
}

/** Aggregate ok from ordered checks (all must pass and path present). */
export function aggregateValidationOk(
	checks: readonly ProjectValidationCheck[],
	canonicalPath: string | null,
): boolean {
	return canonicalPath !== null && checks.every((c) => c.ok);
}
