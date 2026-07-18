export interface AttentionCardProps {
	projectId: string;
	releaseId?: string;
	featureId: string;
	reason: string;
	state: string;
	age: string;
	category: string;
	primaryAction: string;
	onAction?: () => void;
}

export function AttentionCard({
	projectId,
	releaseId,
	featureId,
	reason,
	state,
	age,
	primaryAction,
	onAction,
}: AttentionCardProps) {
	return (
		<article className="attention-card" aria-label={reason}>
			<header>
				<span className="project-id">{projectId}</span>
				{releaseId && <span className="release-id">{releaseId}</span>}
				<span className="feature-id">{featureId}</span>
			</header>
			<p className="reason">{reason}</p>
			<dl>
				<dt>State</dt>
				<dd>{state}</dd>
				<dt>Age</dt>
				<dd>{age}</dd>
			</dl>
			<button type="button" onClick={onAction}>
				{primaryAction}
			</button>
		</article>
	);
}
