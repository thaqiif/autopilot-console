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

function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	} catch {
		return iso;
	}
}

function StatusBadge({ status }: { status: string }) {
	return <span>{status}</span>;
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
								<dd>{formatTime(attempt.queuedAt)}</dd>
								{attempt.startedAt && (
									<>
										<dt>Started</dt>
										<dd>{formatTime(attempt.startedAt)}</dd>
									</>
								)}
								{attempt.endedAt && (
									<>
										<dt>Ended</dt>
										<dd>{formatTime(attempt.endedAt)}</dd>
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
