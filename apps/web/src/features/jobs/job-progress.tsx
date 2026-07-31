import { formatElapsedMs } from "../../time/elapsed";
import { LocalDateTime } from "../../time/local-date-time";
import type { RequirementSummary } from "../tasks/requirement-card";
import { RequirementCard } from "../tasks/requirement-card";

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
	dependsOn?: string[];
	acceptance?: string[];
	stuckReason?: string;
	invalidTestReason?: string;
	blockedReason?: string;
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

function toRequirementSummary(req: RequirementProgress): RequirementSummary {
	return {
		id: req.id,
		description: req.description,
		status: req.status,
		passes: req.passes,
		stuck: req.stuck,
		stuckReason: req.stuckReason,
		invalidTest: req.invalidTest,
		invalidTestReason: req.invalidTestReason,
		blockedReason: req.blockedReason,
		dependsOn: req.dependsOn ?? [],
		acceptance: req.acceptance ?? [],
		redPhase: req.redPhase,
		greenPhase: req.greenPhase,
		refactorPhase: req.refactorPhase,
	};
}

export function JobProgress({
	featureState,
	totalRequirements,
	passedRequirements,
	activeRequirements,
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

			{(isStale || lastUpdate || onRefresh) && (
				<div>
					{lastUpdate && (
						<p>
							Last update: <LocalDateTime utc={lastUpdate} format="time" showTimezone />
						</p>
					)}
					{isStale && (
						<div data-view-state="stale" role="status" aria-live="polite" className="view-state">
							<span className="view-state-icon" aria-hidden="true" title="Stale">
								↻
							</span>
							<p>Live updates disconnected — reconciling from persisted state.</p>
						</div>
					)}
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
				<dt>Active</dt>
				<dd>{activeRequirements}</dd>
				<dt>Stuck</dt>
				<dd>{stuckRequirements}</dd>
				<dt>Invalid</dt>
				<dd>{invalidRequirements}</dd>
				<dt>Remaining</dt>
				<dd>{remainingRequirements}</dd>
			</dl>

			<dl>
				<dt>State</dt>
				<dd data-status={featureState.toLowerCase()}>{featureState.replace(/_/g, " ")}</dd>
				{workerState && (
					<>
						<dt>Worker</dt>
						<dd>{workerState}</dd>
					</>
				)}
				{queueTime && (
					<>
						<dt>Queued</dt>
						<dd>
							<LocalDateTime utc={queueTime} format="time" showTimezone />
						</dd>
					</>
				)}
				{startTime && (
					<>
						<dt>Started</dt>
						<dd>
							<LocalDateTime utc={startTime} format="time" showTimezone />
						</dd>
					</>
				)}
				{elapsedMs != null && (
					<>
						<dt>Elapsed</dt>
						<dd>{formatElapsedMs(elapsedMs)}</dd>
					</>
				)}
				{lastHeartbeat && (
					<>
						<dt>Last Heartbeat</dt>
						<dd>
							<LocalDateTime utc={lastHeartbeat} format="time" showTimezone />
						</dd>
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
					<RequirementCard key={req.id} requirement={toRequirementSummary(req)} />
				))}
			</section>

			{recentActivity && recentActivity.length > 0 && (
				<section aria-label="Recent activity">
					<h4>Recent Activity</h4>
					<ul>
						{recentActivity.map((evt) => (
							<li key={evt.id}>
								<LocalDateTime utc={evt.timestamp} format="time" showTimezone />
								<span>{evt.message}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</section>
	);
}
