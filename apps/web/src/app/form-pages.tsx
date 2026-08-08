import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/auth-provider";
import { ViewState } from "../components/feedback/view-state";
import { FeatureForm, type FeatureFormData } from "../features/features/feature-form";
import { ProjectForm, type ProjectFormData } from "../features/projects/project-form";
import type { ValidationCheck } from "../features/projects/project-validation-results";
import { ReleaseForm, type ReleaseFormData } from "../features/releases/release-form";

function message(result: { ok: false; error: { message: string } }): string {
	return result.error.message;
}

interface ProjectValidationPayload {
	ok: boolean;
	canonicalPath: string | null;
	checks: ValidationCheck[];
}

export function ProjectFormPage() {
	const { client } = useAuth();
	const { id } = useParams();
	const navigate = useNavigate();
	const [initialData, setInitialData] = useState<Partial<ProjectFormData> | undefined>();
	const [loading, setLoading] = useState(Boolean(id));
	const [submitting, setSubmitting] = useState(false);
	const [validating, setValidating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [checks, setChecks] = useState<ValidationCheck[]>([]);
	const [allPassed, setAllPassed] = useState(false);

	useEffect(() => {
		if (!id) return;
		void client.get<Record<string, unknown>>(`/api/projects/${id}`).then((result) => {
			if (!result.ok) {
				setError(message(result));
				setLoading(false);
				return;
			}
			setInitialData({
				name: String(result.data.name ?? ""),
				slug: String(result.data.slug ?? ""),
				githubOwner: String(result.data.githubOwner ?? ""),
				githubRepo: String(result.data.githubRepo ?? ""),
				workspacePath: String(result.data.canonicalPath ?? result.data.workspacePath ?? ""),
				developmentBranch: String(result.data.developmentBranch ?? ""),
				description: String(result.data.description ?? ""),
			});
			// Existing projects already passed validation to be saved; allow edit save
			// after an explicit re-validate so protected field changes stay safe.
			setLoading(false);
		});
	}, [client, id]);

	async function validate(data: ProjectFormData) {
		setValidating(true);
		setError(null);
		setAllPassed(false);
		const result = await client.post<ProjectValidationPayload>("/api/projects/validate", data);
		setValidating(false);
		if (!result.ok) {
			setChecks([]);
			setError(message(result));
			return;
		}
		setChecks(result.data.checks ?? []);
		setAllPassed(Boolean(result.data.ok));
	}

	async function save(data: ProjectFormData) {
		if (!allPassed) return;
		setSubmitting(true);
		setError(null);
		const operationKey = client.generateOperationKey({
			operation: id ? "project.update" : "project.create",
			projectId: id ?? data.slug,
			subject: data.slug,
		});
		const result = id
			? await client.put<{ id: string }>(`/api/projects/${id}`, data, { operationKey })
			: await client.post<{ id: string }>("/api/projects", data, { operationKey });
		setSubmitting(false);
		if (!result.ok) {
			setError(message(result));
			return;
		}
		navigate(`/projects/${result.data.id}`);
	}

	if (loading) return <ViewState state="loading" />;
	return (
		<section aria-label={id ? "Edit project" : "Register project"}>
			<header>
				<h1>{id ? "Edit project" : "Add project"}</h1>
			</header>
			<ProjectForm
				key={id ?? "new"}
				initialData={initialData}
				onSubmit={(data) => void save(data)}
				onCancel={() => navigate(id ? `/projects/${id}` : "/projects")}
				onValidate={(data) => void validate(data)}
				onFieldsChange={() => {
					setAllPassed(false);
				}}
				isSubmitting={submitting}
				isValidating={validating}
				serverError={error}
				validationChecks={checks}
				validationAllPassed={allPassed}
			/>
		</section>
	);
}

export function ReleaseFormPage() {
	const { client } = useAuth();
	const { id } = useParams();
	const [search] = useSearchParams();
	const navigate = useNavigate();
	const [projectId, setProjectId] = useState(search.get("projectId") ?? "");
	const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
	const [initialData, setInitialData] = useState<Partial<ReleaseFormData> | undefined>();
	const [loading, setLoading] = useState(Boolean(id));
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (id) {
			void client.get<Record<string, unknown>>(`/api/releases/${id}`).then((result) => {
				if (!result.ok) {
					setError(message(result));
					setLoading(false);
					return;
				}
				setProjectId(String(result.data.projectId ?? ""));
				setInitialData({
					name: String(result.data.name ?? ""),
					version: String(result.data.version ?? ""),
					description: String(result.data.description ?? ""),
				});
				setLoading(false);
			});
		} else if (!projectId) {
			void client.get<Array<{ id: string; name: string }>>("/api/projects").then((result) => {
				if (result.ok) setProjects(result.data);
			});
		}
	}, [client, id, projectId]);

	async function save(data: ReleaseFormData) {
		if (!projectId) {
			setError("Select a project.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const operationKey = client.generateOperationKey({
			operation: id ? "release.update" : "release.create",
			projectId,
			subject: id ?? data.version,
		});
		const result = id
			? await client.put<{ id: string }>(`/api/releases/${id}`, data, { operationKey })
			: await client.post<{ id: string }>(
					"/api/releases",
					{ projectId, ...data },
					{ operationKey },
				);
		setSubmitting(false);
		if (!result.ok) {
			setError(message(result));
			return;
		}
		navigate(`/releases/${result.data.id}`);
	}

	if (loading) return <ViewState state="loading" />;
	return (
		<section aria-label={id ? "Edit release" : "Create release"}>
			<header>
				<h1>{id ? "Edit release" : "Add release"}</h1>
			</header>
			{!id && !search.get("projectId") && (
				<label htmlFor="release-project">
					Project
					<select
						id="release-project"
						value={projectId}
						onChange={(event) => setProjectId(event.target.value)}
						required
					>
						<option value="">Select a project</option>
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
				</label>
			)}
			<ReleaseForm
				key={id ?? "new"}
				initialData={initialData}
				onSubmit={(data) => void save(data)}
				onCancel={() => navigate(id ? `/releases/${id}` : "/releases")}
				isSubmitting={submitting}
				serverError={error}
			/>
		</section>
	);
}

export function FeatureFormPage() {
	const { client } = useAuth();
	const { id } = useParams();
	const [search] = useSearchParams();
	const navigate = useNavigate();
	const projectId = search.get("projectId") ?? "";
	const releaseId = search.get("releaseId") ?? "";
	const [initialData, setInitialData] = useState<Partial<FeatureFormData> | undefined>();
	const [loading, setLoading] = useState(Boolean(id));
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!id) return;
		void client.get<Record<string, unknown>>(`/api/features/${id}`).then((result) => {
			if (!result.ok) setError(message(result));
			else {
				setInitialData({
					title: String(result.data.title ?? ""),
					slug: String(result.data.slug ?? ""),
					summary: String(result.data.summary ?? ""),
				});
			}
			setLoading(false);
		});
	}, [client, id]);

	async function save(data: FeatureFormData) {
		if (!id && (!projectId || !releaseId)) {
			setError("Project and release context are required.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const operationKey = client.generateOperationKey({
			operation: id ? "feature.update" : "feature.create",
			projectId: projectId || id || "unknown",
			featureId: id,
			subject: data.slug,
		});
		const result = id
			? await client.put<{ id: string }>(`/api/features/${id}`, data, { operationKey })
			: await client.post<{ id: string }>(
					"/api/features",
					{ projectId, releaseId, ...data },
					{ operationKey },
				);
		setSubmitting(false);
		if (!result.ok) {
			setError(message(result));
			return;
		}
		navigate(`/features/${result.data.id}`);
	}

	if (loading) return <ViewState state="loading" />;
	return (
		<section aria-label={id ? "Edit feature" : "Create feature"}>
			<header>
				<h1>{id ? "Edit feature" : "Add feature"}</h1>
			</header>
			<FeatureForm
				key={id ?? "new"}
				initialData={initialData}
				onSubmit={(data) => void save(data)}
				onCancel={() =>
					navigate(id ? `/features/${id}` : releaseId ? `/releases/${releaseId}` : "/")
				}
				isSubmitting={submitting}
				serverError={error}
			/>
		</section>
	);
}
