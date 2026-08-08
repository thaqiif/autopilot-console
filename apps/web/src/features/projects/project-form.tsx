import { type FormEvent, useState } from "react";
import { ProjectValidationResults, type ValidationCheck } from "./project-validation-results";

export interface ProjectFormData {
	name: string;
	slug: string;
	githubOwner: string;
	githubRepo: string;
	workspacePath: string;
	developmentBranch: string;
	description: string;
}

export interface ProjectFormProps {
	onSubmit: (data: ProjectFormData) => void;
	onCancel: () => void;
	initialData?: Partial<ProjectFormData>;
	isSubmitting?: boolean;
	serverError?: string | null;
	/** Per-check validation results from the last validate call. */
	validationChecks?: ValidationCheck[];
	/** True only when every required check has passed. */
	validationAllPassed?: boolean;
	/** Run server-side path/Git/branch/Autopilot/gh checks without saving. */
	onValidate?: (data: ProjectFormData) => void;
	isValidating?: boolean;
	/** Notify parent that fields changed so prior validation is invalidated. */
	onFieldsChange?: () => void;
}

export function ProjectForm({
	onSubmit,
	onCancel,
	initialData,
	isSubmitting,
	serverError,
	validationChecks,
	validationAllPassed = false,
	onValidate,
	isValidating,
	onFieldsChange,
}: ProjectFormProps) {
	const [name, setName] = useState(initialData?.name ?? "");
	const [slug, setSlug] = useState(initialData?.slug ?? "");
	const [githubOwner, setGithubOwner] = useState(initialData?.githubOwner ?? "");
	const [githubRepo, setGithubRepo] = useState(initialData?.githubRepo ?? "");
	const [workspacePath, setWorkspacePath] = useState(initialData?.workspacePath ?? "");
	const [developmentBranch, setDevelopmentBranch] = useState(initialData?.developmentBranch ?? "");
	const [description, setDescription] = useState(initialData?.description ?? "");

	function updateField<T>(setter: (value: T) => void, value: T) {
		setter(value);
		onFieldsChange?.();
	}

	function currentData(): ProjectFormData {
		return {
			name,
			slug,
			githubOwner,
			githubRepo,
			workspacePath,
			developmentBranch,
			description,
		};
	}

	function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (!validationAllPassed || isSubmitting) return;
		onSubmit(currentData());
	}

	function handleValidate() {
		if (!onValidate || isValidating) return;
		onValidate(currentData());
	}

	const saveDisabled = Boolean(isSubmitting) || !validationAllPassed;

	return (
		<form onSubmit={handleSubmit} aria-label="Project form" noValidate={false}>
			{serverError && (
				<div role="alert" aria-live="assertive">
					<p>{serverError}</p>
				</div>
			)}

			<div>
				<label htmlFor="project-name">Name</label>
				<input
					id="project-name"
					name="name"
					value={name}
					onChange={(e) => updateField(setName, e.target.value)}
					required
					aria-required="true"
				/>
			</div>

			<div>
				<label htmlFor="project-slug">Slug</label>
				<input
					id="project-slug"
					name="slug"
					value={slug}
					onChange={(e) => updateField(setSlug, e.target.value)}
					required
					aria-required="true"
				/>
			</div>

			<div>
				<label htmlFor="project-github-owner">GitHub owner</label>
				<input
					id="project-github-owner"
					name="githubOwner"
					value={githubOwner}
					onChange={(e) => updateField(setGithubOwner, e.target.value)}
					required
					aria-required="true"
				/>
			</div>

			<div>
				<label htmlFor="project-github-repo">Repository</label>
				<input
					id="project-github-repo"
					name="githubRepo"
					value={githubRepo}
					onChange={(e) => updateField(setGithubRepo, e.target.value)}
					required
					aria-required="true"
				/>
			</div>

			<div>
				<label htmlFor="project-workspace-path">Workspace path</label>
				<input
					id="project-workspace-path"
					name="workspacePath"
					value={workspacePath}
					onChange={(e) => updateField(setWorkspacePath, e.target.value)}
					required
					aria-required="true"
					autoComplete="off"
					spellCheck={false}
				/>
			</div>

			<div>
				<label htmlFor="project-development-branch">Development branch</label>
				<input
					id="project-development-branch"
					name="developmentBranch"
					value={developmentBranch}
					onChange={(e) => updateField(setDevelopmentBranch, e.target.value)}
					required
					aria-required="true"
				/>
			</div>

			<div>
				<label htmlFor="project-description">Description</label>
				<textarea
					id="project-description"
					name="description"
					value={description}
					onChange={(e) => updateField(setDescription, e.target.value)}
				/>
			</div>

			{validationChecks && validationChecks.length > 0 && (
				<ProjectValidationResults checks={validationChecks} allPassed={validationAllPassed} />
			)}

			<div>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				{onValidate && (
					<button
						type="button"
						onClick={handleValidate}
						disabled={Boolean(isValidating || isSubmitting)}
						aria-label="Validate"
						aria-busy={Boolean(isValidating)}
					>
						{isValidating ? "Validating..." : "Validate"}
					</button>
				)}
				<button type="submit" disabled={saveDisabled} aria-disabled={saveDisabled}>
					{initialData?.name ? "Save" : "Create project"}
				</button>
			</div>
		</form>
	);
}
