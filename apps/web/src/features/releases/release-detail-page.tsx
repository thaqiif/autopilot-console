import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/auth-provider";
import { ConfirmDialog } from "../../components/feedback/confirm-dialog";
import { ViewState } from "../../components/feedback/view-state";

interface FeatureSummary {
	id: string;
	title: string;
	slug: string;
	state: string;
	branchName: string;
}

interface ReleaseDetail {
	id: string;
	projectId: string;
	name: string;
	version: string;
	description: string | null;
	status: string;
	features: FeatureSummary[];
	developmentProgress: { total: number; merged: number };
}

export function ReleaseDetailPage() {
	const { id } = useParams<{ id: string }>();
	const { client } = useAuth();
	const [release, setRelease] = useState<ReleaseDetail | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [actionError, setActionError] = useState<string | null>(null);
	const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
	const [archiving, setArchiving] = useState(false);

	useEffect(() => {
		let active = true;
		async function load() {
			const result = await client.get<ReleaseDetail>(`/api/releases/${id}`);
			if (!active) return;
			if (!result.ok) {
				setState("error");
				return;
			}
			setRelease(result.data);
			setState("ready");
		}
		void load();
		return () => {
			active = false;
		};
	}, [client, id]);

	async function handleArchive() {
		if (!release) return;
		setArchiving(true);
		setActionError(null);
		const operationKey = client.generateOperationKey({
			operation: "release.archive",
			projectId: release.projectId,
			subject: release.id,
		});
		const result = await client.post<Partial<ReleaseDetail>>(
			`/api/releases/${release.id}/archive`,
			{},
			{ operationKey },
		);
		setArchiving(false);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		setRelease({ ...release, ...result.data, status: result.data.status ?? "archived" });
		setShowArchiveConfirm(false);
	}

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Release not found" />;

	if (!release) return null;

	const progress = release.developmentProgress ?? { total: 0, merged: 0 };

	return (
		<section aria-label={`Release ${release.name}`}>
			<header>
				<h1>{release.name}</h1>
				<span>{release.version}</span>
				<span>{release.status}</span>
			</header>

			{release.description && <p>{release.description}</p>}

			<div>
				<span>
					Development: {progress.merged} / {progress.total} merged
				</span>
			</div>

			{release.status !== "archived" && (
				<div>
					<Link to={`/releases/${release.id}/edit`}>Edit</Link>
					<button type="button" onClick={() => setShowArchiveConfirm(true)}>
						Archive
					</button>
				</div>
			)}
			{actionError && (
				<div role="alert" aria-live="assertive">
					<p>{actionError}</p>
					<p>
						Release archival for <strong>{release.name}</strong> is blocked while related jobs are
						queued or active.
					</p>
				</div>
			)}

			{showArchiveConfirm && (
				<ConfirmDialog
					label="Confirm archive"
					entityName={release.name}
					action="archive"
					busy={archiving}
					onCancel={() => setShowArchiveConfirm(false)}
					onConfirm={handleArchive}
				/>
			)}

			<section aria-label="Features">
				<header>
					<h2>Features</h2>
					<Link to={`/features/new?projectId=${release.projectId}&releaseId=${release.id}`}>
						Add feature
					</Link>
				</header>

				{release.features.length === 0 ? (
					<ViewState state="empty" message="No features" />
				) : (
					<ul className="entity-card-list">
						{release.features.map((feature) => (
							<li key={feature.id}>
								<Link to={`/features/${feature.id}`}>
									<article className="entity-card">
										<h3>{feature.title}</h3>
										<span>{feature.slug}</span>
										<span>{feature.state}</span>
										<span>{feature.branchName}</span>
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
