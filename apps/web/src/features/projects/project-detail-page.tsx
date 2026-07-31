import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";

interface ReleaseSummary {
	id: string;
	name: string;
	version: string;
	status: string;
	archivedAt: string | null;
}

interface ProjectDetail {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	githubOwner: string;
	githubRepo: string;
	developmentBranch: string;
	canonicalPath: string;
	status: string;
	archivedAt: string | null;
	releases: ReleaseSummary[];
}

export function ProjectDetailPage() {
	const { id } = useParams<{ id: string }>();
	const { client } = useAuth();
	const [project, setProject] = useState<ProjectDetail | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [actionError, setActionError] = useState<string | null>(null);
	const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
	const [archiving, setArchiving] = useState(false);

	useEffect(() => {
		let active = true;
		async function load() {
			const result = await client.get<ProjectDetail>(`/api/projects/${id}`);
			if (!active) return;
			if (!result.ok) {
				setState("error");
				return;
			}
			setProject(result.data);
			setState("ready");
		}
		void load();
		return () => {
			active = false;
		};
	}, [client, id]);

	async function handleArchive() {
		if (!project) return;
		setArchiving(true);
		setActionError(null);
		const operationKey = client.generateOperationKey({
			operation: "project.archive",
			projectId: project.id,
		});
		const result = await client.post<Partial<ProjectDetail>>(
			`/api/projects/${project.id}/archive`,
			{},
			{ operationKey },
		);
		setArchiving(false);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		setProject({ ...project, ...result.data, status: result.data.status ?? "archived" });
		setShowArchiveConfirm(false);
	}

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Project not found" />;

	if (!project) return null;

	return (
		<section aria-label={`Project ${project.name}`}>
			<header>
				<h1>{project.name}</h1>
				<span>{project.status}</span>
			</header>

			<dl>
				<dt>Repository</dt>
				<dd>
					{project.githubOwner}/{project.githubRepo}
				</dd>
				<dt>Branch</dt>
				<dd>{project.developmentBranch}</dd>
				{project.canonicalPath && (
					<>
						<dt>Server path</dt>
						<dd>
							<code>{project.canonicalPath}</code>
						</dd>
					</>
				)}
				{project.description && (
					<>
						<dt>Description</dt>
						<dd>{project.description}</dd>
					</>
				)}
			</dl>

			{project.status === "active" && (
				<div>
					<Link to={`/projects/${project.id}/edit`}>Edit</Link>
					<button type="button" onClick={() => setShowArchiveConfirm(true)}>
						Archive
					</button>
				</div>
			)}
			{actionError && (
				<div role="alert" aria-live="assertive">
					<p>{actionError}</p>
					<p>
						Protected project changes and archival are blocked while queued or active jobs exist for{" "}
						{project.name}.
					</p>
				</div>
			)}

			{showArchiveConfirm && (
				<div role="dialog" aria-modal="true" aria-label="Confirm archive">
					<p>
						Are you sure you want to archive <strong>{project.name}</strong>?
					</p>
					<button type="button" onClick={() => setShowArchiveConfirm(false)}>
						Cancel
					</button>
					<button type="button" onClick={handleArchive} disabled={archiving}>
						Confirm archive
					</button>
				</div>
			)}

			<section aria-label="Releases">
				<header>
					<h2>Releases</h2>
					<Link to={`/releases/new?projectId=${project.id}`}>Add release</Link>
				</header>

				{project.releases.length === 0 ? (
					<ViewState state="empty" message="No releases" />
				) : (
					<ul className="entity-card-list">
						{project.releases.map((release) => (
							<li key={release.id}>
								<Link to={`/releases/${release.id}`}>
									<article className="entity-card">
										<h3>{release.name}</h3>
										<span>{release.version}</span>
										<span>{release.status}</span>
									</article>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</section>
	);
}
