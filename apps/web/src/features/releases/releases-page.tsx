import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isUnauthorized } from "../../api/result";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
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

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

export function ReleasesPage() {
	const { client } = useAuth();
	const [releases, setReleases] = useState<ReleaseSummary[]>([]);
	const [state, setState] = useState<PageState>("loading");

	const load = useCallback(async () => {
		try {
			const res = await client.get<ReleaseSummary[]>("/api/releases");
			if (isUnauthorized(res)) {
				setState("unauthorized");
				return;
			}
			if (!res.ok) {
				setState("error");
				return;
			}
			setReleases(res.data ?? []);
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
	if (state === "error") return <ViewState state="error" message="Failed to load releases" />;

	return (
		<section aria-label="Releases">
			<header className="page-header">
				<h1>Releases</h1>
				<Link to="/releases/new">Add release</Link>
			</header>

			{releases.length === 0 ? (
				<ViewState state="empty" message="No releases" />
			) : (
				<ul className="entity-card-list">
					{releases.map((release) => (
						<li key={release.id}>
							<article className="entity-card">
								<header>
									<Link to={`/releases/${release.id}`}>
										<h2>{release.name}</h2>
									</Link>
									<span>{release.version}</span>
									<span data-status={release.status.toLowerCase()}>{release.status}</span>
								</header>
								{release.projectName && <span>{release.projectName}</span>}
								{release.developmentProgress && (
									<span>
										Development: {release.developmentProgress.merged} /{" "}
										{release.developmentProgress.total} merged
									</span>
								)}
							</article>
						</li>
					))}
				</ul>
			)}

			{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
		</section>
	);
}
