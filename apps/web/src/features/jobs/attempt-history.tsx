import { LocalDateTime } from "../../time/local-date-time";

export interface AttemptRecord {
	id: string;
	status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELLED";
	predecessorAttemptId?: string;
	queuedAt: string;
	startedAt?: string;
	endedAt?: string;
	workerId?: string;
	exitCode?: number;
	resultSummary?: string;
	logExcerpt?: string;
}

export interface AttemptHistoryProps {
	attempts: AttemptRecord[];
}

function StatusBadge({ status }: { status: string }) {
	return <span data-status={status.toLowerCase()}>{status}</span>;
}

export function AttemptHistory({ attempts }: AttemptHistoryProps) {
	if (attempts.length === 0) {
		return (
			<section aria-label="Attempt history">
				<h3>Attempt History</h3>
				<p>No attempts</p>
			</section>
		);
	}

	return (
		<section aria-label="Attempt history">
			<h3>Attempt History</h3>
			<ol>
				{attempts.map((attempt) => (
					<li key={attempt.id}>
						<article aria-label={`Attempt ${attempt.id}`}>
							<header>
								<span>{attempt.id}</span>
								<StatusBadge status={attempt.status} />
							</header>
							<dl>
								<dt>Queued</dt>
								<dd>
									<LocalDateTime utc={attempt.queuedAt} showTimezone />
								</dd>
								{attempt.startedAt && (
									<>
										<dt>Started</dt>
										<dd>
											<LocalDateTime utc={attempt.startedAt} showTimezone />
										</dd>
									</>
								)}
								{attempt.endedAt && (
									<>
										<dt>Ended</dt>
										<dd>
											<LocalDateTime utc={attempt.endedAt} showTimezone />
										</dd>
									</>
								)}
								{attempt.workerId && (
									<>
										<dt>Worker</dt>
										<dd>{attempt.workerId}</dd>
									</>
								)}
								{attempt.exitCode != null && (
									<>
										<dt>Exit Code</dt>
										<dd>{attempt.exitCode}</dd>
									</>
								)}
								{attempt.predecessorAttemptId && (
									<>
										<dt>Predecessor</dt>
										<dd>{attempt.predecessorAttemptId}</dd>
									</>
								)}
							</dl>
							{attempt.resultSummary && <p>{attempt.resultSummary}</p>}
							{attempt.logExcerpt && (
								<details>
									<summary>Log excerpt</summary>
									<pre>
										<code>{attempt.logExcerpt}</code>
									</pre>
								</details>
							)}
						</article>
					</li>
				))}
			</ol>
		</section>
	);
}
