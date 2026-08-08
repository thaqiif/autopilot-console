import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isUnauthorized } from "../../api/result";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";

interface ProjectSummary {
	id: string;
	name: string;
	slug: string;
	status: string;
	githubOwner: string;
	githubRepo: string;
	developmentBranch: string;
}

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

export function ProjectsPage() {
	const { client } = useAuth();
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [state, setState] = useState<PageState>("loading");

	const load = useCallback(async () => {
		try {
			const res = await client.get<ProjectSummary[]>("/api/projects");
			if (isUnauthorized(res)) {
				setState("unauthorized");
				return;
			}
			if (!res.ok) {
				setState("error");
				return;
			}
			setProjects(res.data ?? []);
			setState("ready");
		} catch {
			setState("error");
		}
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	useSseRestRefresh(load, {
		onStale: () => setState((current) => (current === "ready" ? "stale" : current)),
	});

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error") return <ViewState state="error" message="Failed to load projects" />;

	return (
		<section aria-label="Projects">
			<header className="page-header">
				<h1>Projects</h1>
				<Link to="/projects/new">Add project</Link>
			</header>

			{projects.length === 0 ? (
				<ViewState state="empty" message="No projects" />
			) : (
				<ul className="entity-card-list">
					{projects.map((project) => (
						<li key={project.id}>
							<article className="entity-card">
								<header>
									<Link to={`/projects/${project.id}`}>
										<h2>{project.name}</h2>
									</Link>
									<span data-status={project.status.toLowerCase()}>{project.status}</span>
								</header>
								<dl>
									<dt>Repository</dt>
									<dd>
										{project.githubOwner}/{project.githubRepo}
									</dd>
									<dt>Branch</dt>
									<dd>{project.developmentBranch}</dd>
								</dl>
							</article>
						</li>
					))}
				</ul>
			)}

			{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
		</section>
	);
}
