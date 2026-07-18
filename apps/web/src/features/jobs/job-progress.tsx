export interface RequirementProgress {
	id: string;
	description: string;
	status: "not_started" | "in_progress" | "passed" | "stuck" | "invalid";
	passes: boolean;
	stuck: boolean;
	invalidTest: boolean;
	redPhase: boolean;
	greenPhase: boolean;
	refactorPhase: boolean;
}

export interface ActivityEvent {
	id: string;
	type: string;
	message: string;
	timestamp: string;
}

export interface JobProgressProps {
	featureId: string;
	featureState: string;
	totalRequirements: number;
	passedRequirements: number;
	activeRequirements: number;
	stuckRequirements: number;
	invalidRequirements: number;
	remainingRequirements: number;
	requirements: RequirementProgress[];
	queueTime?: string;
	startTime?: string;
	elapsedMs?: number;
	workerId?: string;
	workerState?: string;
	lastHeartbeat?: string;
	lastUpdate?: string;
	activeRequirementId?: string;
	recentActivity?: ActivityEvent[];
	diagnosticLogExcerpt?: string;
	isStale?: boolean;
	onRefresh?: () => void;
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes} min ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatTime(iso?: string): string {
	if (!iso) return "—";
	try {
		return new Date(iso).toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	} catch {
		return iso;
	}
}

function TDDPhases({ req }: { req: RequirementProgress }) {
	return (
		<span>
			Red: {req.redPhase ? "Complete" : "Pending"} | Green:{" "}
			{req.greenPhase ? "Complete" : "Pending"} | Refactor:{" "}
			{req.refactorPhase ? "Complete" : "Pending"}
		</span>
	);
}

export function JobProgress({
	featureState,
	totalRequirements,
	passedRequirements,
	stuckRequirements,
	invalidRequirements,
	remainingRequirements,
	requirements,
	queueTime,
	startTime,
	elapsedMs,
	workerState,
	lastHeartbeat,
	lastUpdate,
	activeRequirementId,
	recentActivity,
	isStale,
	onRefresh,
}: JobProgressProps) {
	const activeReq = activeRequirementId
		? requirements.find((r) => r.id === activeRequirementId)
		: undefined;

	return (
		<section aria-label="Development progress">
			<h3>Progress</h3>

			{isStale && (
				<div role="status">
					<p>Last update: {formatTime(lastUpdate)}</p>
					{onRefresh && (
						<button type="button" onClick={onRefresh}>
							Refresh
						</button>
					)}
				</div>
			)}

			<dl>
				<dt>Total</dt>
				<dd>{totalRequirements}</dd>
				<dt>Passed</dt>
				<dd>{passedRequirements}</dd>
				<dt>Stuck</dt>
				<dd>{stuckRequirements}</dd>
				<dt>Invalid</dt>
				<dd>{invalidRequirements}</dd>
				<dt>Remaining</dt>
				<dd>{remainingRequirements}</dd>
			</dl>

			<dl>
				<dt>State</dt>
				<dd>{featureState.replace(/_/g, " ")}</dd>
				{workerState && (
					<>
						<dt>Worker</dt>
						<dd>{workerState}</dd>
					</>
				)}
				{queueTime && (
					<>
						<dt>Queued</dt>
						<dd>{formatTime(queueTime)}</dd>
					</>
				)}
				{startTime && (
					<>
						<dt>Started</dt>
						<dd>{formatTime(startTime)}</dd>
					</>
				)}
				{elapsedMs != null && (
					<>
						<dt>Elapsed</dt>
						<dd>{formatElapsed(elapsedMs)}</dd>
					</>
				)}
				{lastHeartbeat && (
					<>
						<dt>Last Heartbeat</dt>
						<dd>{formatTime(lastHeartbeat)}</dd>
					</>
				)}
			</dl>

			{activeReq && (
				<div>
					<strong>Active requirement: </strong>
					<span>{activeReq.description}</span>
				</div>
			)}

			<section aria-label="Requirements">
				<h4>Requirements</h4>
				{requirements.map((req) => (
					<article key={req.id} aria-label={`Requirement ${req.id}`}>
						<header>
							<span>{req.id}</span>
							<span>{req.description}</span>
							<span>
								{req.passes
									? "Passed"
									: req.stuck
										? "Stuck"
										: req.invalidTest
											? "Invalid"
											: req.status === "in_progress"
												? "In Progress"
												: "Not Started"}
							</span>
						</header>
						<TDDPhases req={req} />
					</article>
				))}
			</section>

			{recentActivity && recentActivity.length > 0 && (
				<section aria-label="Recent activity">
					<h4>Recent Activity</h4>
					<ul>
						{recentActivity.map((evt) => (
							<li key={evt.id}>
								<time dateTime={evt.timestamp}>{formatTime(evt.timestamp)}</time>
								<span>{evt.message}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</section>
	);
}
