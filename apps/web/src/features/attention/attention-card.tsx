import { Link } from "react-router-dom";

export interface AttentionCardProps {
	projectId: string;
	releaseId?: string;
	featureId: string;
	reason: string;
	state: string;
	age: string;
	category: string;
	primaryAction: string;
	href?: string;
	external?: boolean;
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
	href,
	external,
	onAction,
}: AttentionCardProps) {
	return (
		<article className="attention-card" aria-label={reason}>
			<header>
				<span className="project-id">{projectId}</span>
				{releaseId ? <span className="release-id">{releaseId}</span> : null}
				<span className="feature-id">{featureId}</span>
			</header>
			<p className="reason">{reason}</p>
			<dl>
				<dt>State</dt>
				<dd>{state}</dd>
				<dt>Age</dt>
				<dd>{age}</dd>
			</dl>
			{href ? (
				external ? (
					<a href={href} target="_blank" rel="noopener noreferrer" onClick={onAction}>
						{primaryAction}
					</a>
				) : (
					<Link to={href} onClick={onAction}>
						{primaryAction}
					</Link>
				)
			) : (
				<button type="button" onClick={onAction}>
					{primaryAction}
				</button>
			)}
		</article>
	);
}
