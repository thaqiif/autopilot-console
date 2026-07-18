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
