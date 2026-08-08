import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isUnauthorized } from "../../api/result";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
import { useAuth } from "../../auth/auth-provider";
import { ConfirmDialog } from "../../components/feedback/confirm-dialog";
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

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

export function ProjectDetailPage() {
	const { id } = useParams<{ id: string }>();
	const { client } = useAuth();
	const [project, setProject] = useState<ProjectDetail | null>(null);
	const [state, setState] = useState<PageState>("loading");
	const [actionError, setActionError] = useState<string | null>(null);
	const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
	const [archiving, setArchiving] = useState(false);

	const load = useCallback(async () => {
		const result = await client.get<ProjectDetail>(`/api/projects/${id}`);
		if (isUnauthorized(result)) {
			setState("unauthorized");
			return;
		}
		if (!result.ok) {
			setState("error");
			return;
		}
		setProject(result.data);
		setState("ready");
	}, [client, id]);

	useEffect(() => {
		void load();
	}, [load]);

	useSseRestRefresh(load, {
		onStale: () => setState((current) => (current === "ready" ? "stale" : current)),
	});

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
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error") return <ViewState state="error" message="Project not found" />;

	if (!project) return null;

	return (
		<section aria-label={`Project ${project.name}`}>
			<header className="page-header">
				<h1>{project.name}</h1>
				<span data-status={project.status.toLowerCase()}>{project.status}</span>
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
				<ConfirmDialog
					label="Confirm archive"
					entityName={project.name}
					action="archive"
					busy={archiving}
					onCancel={() => setShowArchiveConfirm(false)}
					onConfirm={handleArchive}
				/>
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
								<article className="entity-card">
									<header>
										<Link to={`/releases/${release.id}`}>
											<h3>{release.name}</h3>
										</Link>
										<span>{release.version}</span>
										<span data-status={release.status.toLowerCase()}>{release.status}</span>
									</header>
								</article>
							</li>
						))}
					</ul>
				)}
				{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
			</section>
		</section>
	);
}
