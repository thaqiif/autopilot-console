/**
 * Project registration service — RED stub (not implemented).
 */

import type { Queryable } from "../../../database/src/client";
import type { AutopilotRunner } from "../../../autopilot/src/index";
import type { GitGateway } from "../../../git/src/index";
import type { GitHubGateway } from "../../../github/src/index";
import type { Project, ProjectActor } from "./project";
import type { ProjectValidationInput, ProjectValidationResult } from "./project-validation";

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
	archiveProject(input: {
		projectId: string;
		actor: ProjectActor;
	}): Promise<ArchiveProjectResult>;
}

export function createProjectService(_options: ProjectServiceOptions): ProjectService {
	throw new Error("project service not implemented");
}
