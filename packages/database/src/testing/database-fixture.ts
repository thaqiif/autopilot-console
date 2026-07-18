import type { Sql } from "../client";
import {
	createFeature,
	createProject,
	createRelease,
	createWorkspace,
	type FeatureRow,
	type ProjectRow,
	type ReleaseRow,
	type WorkspaceRow,
} from "../repositories/core-repositories";

export interface DatabaseFixture {
	twoProjects: () => Promise<{
		workspace: WorkspaceRow;
		projectA: ProjectRow;
		projectB: ProjectRow;
	}>;
	featureReady: () => Promise<{
		workspace: WorkspaceRow;
		projectA: ProjectRow;
		projectB: ProjectRow;
		releaseA: ReleaseRow;
		featureA: FeatureRow;
	}>;
	featureInProject: (projectId: string, slug: string) => Promise<FeatureRow>;
}

export function createDatabaseFixture(sql: Sql): DatabaseFixture {
	return {
		async twoProjects() {
			const workspace = await createWorkspace(sql);
			const projectA = await createProject(sql, {
				workspaceId: workspace.id,
				name: "Project A",
				slug: "project-a",
				githubOwner: "acme",
				githubRepo: "project-a",
				canonicalPath: "/workspaces/project-a",
				developmentBranch: "main",
			});
			const projectB = await createProject(sql, {
				workspaceId: workspace.id,
				name: "Project B",
				slug: "project-b",
				githubOwner: "acme",
				githubRepo: "project-b",
				canonicalPath: "/workspaces/project-b",
				developmentBranch: "main",
			});
			return { workspace, projectA, projectB };
		},

		async featureReady() {
			const base = await this.twoProjects();
			const releaseA = await createRelease(sql, {
				projectId: base.projectA.id,
				name: "1.0.0",
				version: "1.0.0",
				sortOrder: 1,
			});
			const featureA = await createFeature(sql, {
				projectId: base.projectA.id,
				releaseId: releaseA.id,
				slug: "login",
				title: "Login",
				branchName: "feature/f1-login",
			});
			return { ...base, releaseA, featureA };
		},

		async featureInProject(projectId: string, slug: string) {
			const release = await createRelease(sql, {
				projectId,
				name: `rel-${slug}`,
				version: `0.0.${Math.floor(Math.random() * 100000)}`,
				sortOrder: 1,
			});
			return createFeature(sql, {
				projectId,
				releaseId: release.id,
				slug,
				title: slug,
				branchName: `feature/${slug}`,
			});
		},
	};
}
