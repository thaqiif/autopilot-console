import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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

export function ProjectsPage() {
	const { client } = useAuth();
	const [projects, setProjects] = useState<ProjectSummary[]>([]);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		async function load() {
			try {
				const res = await client.get<ProjectSummary[]>("/api/projects");
				if (!res.ok) {
					setState("error");
					return;
				}
				setProjects(res.data ?? []);
				setState("ready");
			} catch {
				setState("error");
			}
		}
		void load();
	}, [client]);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Failed to load projects" />;

	return (
		<section aria-label="Projects">
			<header>
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
									<span>{project.status}</span>
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
		</section>
	);
}
