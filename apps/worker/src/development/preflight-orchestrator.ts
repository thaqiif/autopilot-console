import type { AutopilotRunner } from "../../../../packages/autopilot/src/index";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	ProjectRow,
	TaskApprovalRow,
} from "../../../../packages/database/src/index";
import type { GitGateway } from "../../../../packages/git/src/index";

export type DevelopmentPreflightFailureKind = "validation" | "git";

export class DevelopmentPreflightError extends Error {
	readonly kind: DevelopmentPreflightFailureKind;
	readonly safeToFailAttempt: boolean;

	constructor(kind: DevelopmentPreflightFailureKind, message: string, safeToFailAttempt = true) {
		super(message);
		this.name = "DevelopmentPreflightError";
		this.kind = kind;
		this.safeToFailAttempt = safeToFailAttempt;
	}
}

export interface DevelopmentExecutionContext {
	attempt: DevelopmentAttemptRow;
	project: ProjectRow;
	feature: FeatureRow;
	approval: TaskApprovalRow;
}

export interface PreflightOrchestrator {
	prepare(claimedAttempt: DevelopmentAttemptRow): Promise<DevelopmentExecutionContext>;
}

export interface PreflightOrchestratorOptions {
	loadContext: (claimedAttempt: DevelopmentAttemptRow) => Promise<DevelopmentExecutionContext>;
	git: GitGateway;
	autopilot: AutopilotRunner;
	remoteName?: string;
}

function validationFailure(message: string, safeToFailAttempt = true): never {
	throw new DevelopmentPreflightError("validation", message, safeToFailAttempt);
}

export function createPreflightOrchestrator(
	options: PreflightOrchestratorOptions,
): PreflightOrchestrator {
	const remoteName = options.remoteName ?? "origin";

	return { prepare };

	async function prepare(
		claimedAttempt: DevelopmentAttemptRow,
	): Promise<DevelopmentExecutionContext> {
		const { attempt, project, feature, approval } = await options.loadContext(claimedAttempt);
		if (
			attempt.projectId !== claimedAttempt.projectId ||
			attempt.featureId !== claimedAttempt.featureId ||
			attempt.taskApprovalId !== claimedAttempt.taskApprovalId ||
			attempt.branchName !== claimedAttempt.branchName
		) {
			validationFailure("Claimed attempt identity differs from its persisted record.");
		}
		if (attempt.status !== "RUNNING") {
			validationFailure(`Claimed attempt is not running: ${attempt.status}.`, false);
		}
		if (attempt.processPid !== null || attempt.processStartIdentity !== null) {
			validationFailure(
				"Claimed attempt already has process identity; reconciliation is required.",
				false,
			);
		}
		if (project.status !== "active" || project.archivedAt !== null) {
			validationFailure("Project is archived or inactive.");
		}
		if (feature.archivedAt !== null) validationFailure("Feature is archived.");
		if (
			feature.projectId !== project.id ||
			approval.projectId !== project.id ||
			approval.featureId !== feature.id
		) {
			validationFailure("Attempt hierarchy does not belong to one project and feature.");
		}
		if (approval.invalidatedAt !== null) validationFailure("Task approval is invalidated.");
		if (feature.state !== "QUEUED") {
			validationFailure(`Feature must be QUEUED before development, received ${feature.state}.`);
		}
		if (feature.branchName !== attempt.branchName) {
			validationFailure("Attempt branch differs from the persisted feature branch.");
		}
		if (feature.taskPath !== approval.relativeTaskPath) {
			validationFailure("Approved task path differs from the persisted feature task path.");
		}

		const runtime = await options.autopilot.validateRuntime();
		if (!runtime.ok) validationFailure(runtime.message);
		const task = await options.autopilot.validateTask(
			project.canonicalPath,
			approval.relativeTaskPath,
		);
		if (!task.ok) validationFailure(task.message);
		if (task.checksum !== approval.checksum) {
			validationFailure("Task checksum differs from the approved snapshot.");
		}

		const git = await options.git.preflight({
			projectRoot: project.canonicalPath,
			remoteName,
			expectedRepository: {
				owner: project.githubOwner,
				repository: project.githubRepo,
				fullName: `${project.githubOwner}/${project.githubRepo}`,
			},
			developmentBranch: project.developmentBranch,
			featureBranch: attempt.branchName,
			taskRelativePath: approval.relativeTaskPath,
			taskChecksum: approval.checksum,
			allowTaskArtifactDirty: true,
		});
		if (!git.ok) {
			throw new DevelopmentPreflightError(
				"git",
				git.failures.map((failure) => failure.message).join("; ") || "Git preflight failed.",
			);
		}
		await options.git.ensureFeatureBranch({
			projectRoot: project.canonicalPath,
			remoteName,
			developmentBranch: project.developmentBranch,
			featureBranch: attempt.branchName,
			createIfMissing: attempt.predecessorAttemptId === null,
		});

		return { attempt, project, feature, approval };
	}
}
