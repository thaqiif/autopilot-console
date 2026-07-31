import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";

interface ReleaseSummary {
	id: string;
	projectId: string;
	projectName?: string;
	name: string;
	version: string;
	status: string;
	developmentProgress?: { total: number; merged: number };
}

export function ReleasesPage() {
	const { client } = useAuth();
	const [releases, setReleases] = useState<ReleaseSummary[]>([]);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		async function load() {
			try {
				const res = await client.get<ReleaseSummary[]>("/api/releases");
				if (!res.ok) {
					setState("error");
					return;
				}
				setReleases(res.data);
				setState("ready");
			} catch {
				setState("error");
			}
		}
		load();
	}, [client]);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Failed to load releases" />;

	return (
		<section aria-label="Releases">
			<header>
				<h1>Releases</h1>
				<Link to="/releases/new">Add release</Link>
			</header>

			{releases.length === 0 ? (
				<ViewState state="empty" message="No releases" />
			) : (
				<ul>
					{releases.map((release) => (
						<li key={release.id}>
							<Link to={`/releases/${release.id}`}>
								<article>
									<header>
										<h2>{release.name}</h2>
										<span>{release.version}</span>
									</header>
									{release.projectName && <span>{release.projectName}</span>}
									<span>{release.status}</span>
									{release.developmentProgress && (
										<span>
											Development: {release.developmentProgress.merged} /{" "}
											{release.developmentProgress.total} merged
										</span>
									)}
								</article>
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
