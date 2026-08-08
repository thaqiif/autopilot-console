import { LocalDateTime } from "../../time/local-date-time";

export interface PullRequestStatusProps {
	prNumber?: number;
	prUrl?: string;
	prState?: "OPEN" | "CLOSED" | "MERGED";
	headSha?: string;
	checksStatus?: "PENDING" | "PASSING" | "FAILING" | "NONE";
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";
	mergeCommitSha?: string;
	lastSyncAt?: string;
	isStale?: boolean;
}

function ChecksLabel({ status }: { status?: string }) {
	switch (status) {
		case "PENDING":
			return <span data-status="ci-pending">CI Running</span>;
		case "PASSING":
			return <span data-status="ci-passing">Checks passing</span>;
		case "FAILING":
			return <span data-status="ci-failing">CI Failed</span>;
		case "NONE":
			return <span data-status="ci-none">No checks</span>;
		default:
			return null;
	}
}

function ReviewLabel({ decision }: { decision?: string }) {
	switch (decision) {
		case "APPROVED":
			return <span data-status="review-approved">Approved</span>;
		case "CHANGES_REQUESTED":
			return <span data-status="review-changes">Changes requested</span>;
		case "REVIEW_REQUIRED":
			return <span data-status="review-required">Review required</span>;
		case "NONE":
			return null;
		default:
			return null;
	}
}

export function PullRequestStatus({
	prNumber,
	prUrl,
	prState,
	headSha,
	checksStatus,
	reviewDecision,
	mergeCommitSha,
	lastSyncAt,
	isStale,
}: PullRequestStatusProps) {
	return (
		<section aria-label="Pull request status">
			<h4>Pull Request</h4>

			{prNumber && prUrl && (
				<p>
					<a href={prUrl} target="_blank" rel="noopener noreferrer">
						#{prNumber}
					</a>
				</p>
			)}

			{prState && <span data-status={`pr-${prState.toLowerCase()}`}>{prState}</span>}

			{headSha && (
				<dl>
					<dt>Head SHA</dt>
					<dd>{headSha}</dd>
				</dl>
			)}

			<ChecksLabel status={checksStatus} />
			<ReviewLabel decision={reviewDecision} />

			{mergeCommitSha && (
				<dl>
					<dt>Merge Commit</dt>
					<dd>{mergeCommitSha}</dd>
				</dl>
			)}

			{isStale && (
				<div role="status">
					<p>Sync outdated — data may not reflect latest GitHub state</p>
				</div>
			)}

			{lastSyncAt && (
				<p>
					Last synced: <LocalDateTime utc={lastSyncAt} showTimezone />
				</p>
			)}

			{prUrl && (
				<p>
					<a href={prUrl} target="_blank" rel="noopener noreferrer">
						View on GitHub
					</a>
				</p>
			)}
		</section>
	);
}
