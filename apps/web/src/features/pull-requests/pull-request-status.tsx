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

function formatTime(iso?: string): string {
	if (!iso) return "—";
	try {
		return new Date(iso).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	} catch {
		return iso;
	}
}

function ChecksLabel({ status }: { status?: string }) {
	switch (status) {
		case "PENDING":
			return <span>CI Running</span>;
		case "PASSING":
			return <span>Checks passing</span>;
		case "FAILING":
			return <span>CI Failed</span>;
		case "NONE":
			return <span>No checks</span>;
		default:
			return null;
	}
}

function ReviewLabel({ decision }: { decision?: string }) {
	switch (decision) {
		case "APPROVED":
			return <span>Approved</span>;
		case "CHANGES_REQUESTED":
			return <span>Changes requested</span>;
		case "REVIEW_REQUIRED":
			return <span>Review required</span>;
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

			{prState && <span>{prState}</span>}

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
					<time dateTime={lastSyncAt}>Last synced: {formatTime(lastSyncAt)}</time>
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
