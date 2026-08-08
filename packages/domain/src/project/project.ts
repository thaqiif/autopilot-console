/**
 * Project domain entity shapes (F-2).
 */

export type ProjectStatus = "active" | "archived";

export interface Project {
	id: string;
	workspaceId: string;
	name: string;
	slug: string;
	description: string | null;
	githubOwner: string;
	githubRepo: string;
	canonicalPath: string;
	developmentBranch: string;
	validationStatus: string | null;
	lastValidatedAt: Date | null;
	status: ProjectStatus;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ProjectActor {
	actorType: "administrator" | "api_system" | "worker" | "reconciliation";
	actorId: string;
	actorDisplay?: string;
	correlationId?: string;
}
