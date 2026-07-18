import { useEffect, useState } from "react";
import { ViewState } from "../../components/feedback/view-state";
import { SummaryCard } from "../../components/metrics/summary-card";
import { AttentionCard } from "../attention/attention-card";

interface OverviewMetrics {
	projectCount: number;
	activeJobs: number;
	queuedJobs: number;
	attentionCount: number;
	failedJobs: number;
	prsAwaitingReview: number;
	developmentMergedFeatures: number;
	developmentMergedReleases: number;
}

interface AttentionItem {
	projectId: string;
	releaseId?: string;
	featureId: string;
	reason: string;
	state: string;
	age: string;
	category: string;
	primaryAction: string;
}

interface ActivityEvent {
	id: string;
	projectId?: string;
	featureId?: string;
	type: string;
	summary: string;
	occurredAt: string;
}

const DEFAULT_METRICS: OverviewMetrics = {
	projectCount: 0,
	activeJobs: 0,
	queuedJobs: 0,
	attentionCount: 0,
	failedJobs: 0,
	prsAwaitingReview: 0,
	developmentMergedFeatures: 0,
	developmentMergedReleases: 0,
};

export function OverviewPage() {
	const [metrics, setMetrics] = useState<OverviewMetrics>(DEFAULT_METRICS);
	const [attention, setAttention] = useState<AttentionItem[]>([]);
	const [activity, setActivity] = useState<ActivityEvent[]>([]);
	const [state, setState] = useState<"loading" | "ready" | "error" | "stale">("loading");
	const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

	useEffect(() => {
		async function loadData() {
			try {
				const [metricsRes, attentionRes, activityRes] = await Promise.all([
					fetch("/api/overview", { credentials: "include" }),
					fetch("/api/attention", { credentials: "include" }),
					fetch("/api/activity?limit=5", { credentials: "include" }),
				]);

				if (metricsRes.status === 401 || attentionRes.status === 401) {
					setState("error");
					return;
				}

				if (metricsRes.ok) {
					setMetrics(await metricsRes.json());
				}
				if (attentionRes.ok) {
					const data = await attentionRes.json();
					setAttention(data.items ?? []);
				}
				if (activityRes.ok) {
					const data = await activityRes.json();
					setActivity(data.items ?? []);
				}
				setLastUpdated(new Date());
				setState("ready");
			} catch {
				setState("error");
			}
		}

		loadData();
	}, []);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Failed to load overview" />;

	return (
		<section aria-label="Portfolio overview">
			{/* 1. Attention section — appears FIRST */}
			<section aria-label="Needs your attention">
				<h2>Needs Your Attention</h2>
				{attention.length === 0 ? (
					<ViewState state="empty" message="No attention items" />
				) : (
					<ul>
						{attention.map((item) => (
							<li key={item.featureId}>
								<AttentionCard
									projectId={item.projectId}
									releaseId={item.releaseId}
									featureId={item.featureId}
									reason={item.reason}
									state={item.state}
									age={item.age}
									category={item.category}
									primaryAction={item.primaryAction}
								/>
							</li>
						))}
					</ul>
				)}
			</section>

			{/* 2. Metrics section */}
			<section aria-label="Portfolio metrics">
				<h2>Portfolio Overview</h2>
				<dl>
					<SummaryCard label="Projects" value={metrics.projectCount} />
					<SummaryCard label="Active Jobs" value={metrics.activeJobs} />
					<SummaryCard label="Queued Jobs" value={metrics.queuedJobs} />
					<SummaryCard label="Attention" value={metrics.attentionCount} />
					<SummaryCard label="Failed/Interrupted Jobs" value={metrics.failedJobs} />
					<SummaryCard label="PRs Awaiting Review" value={metrics.prsAwaitingReview} />
					<SummaryCard
						label="Development Merged Features"
						value={metrics.developmentMergedFeatures}
					/>
					<SummaryCard
						label="Development Merged Releases"
						value={metrics.developmentMergedReleases}
					/>
				</dl>
			</section>

			{/* 3. Recent activity */}
			<section aria-label="Recent activity">
				<h2>Recent Activity</h2>
				{activity.length === 0 ? (
					<ViewState state="empty" message="No recent activity" />
				) : (
					<ul>
						{activity.map((event) => (
							<li key={event.id}>
								<span>{event.type}</span>
								<span>{event.summary}</span>
								<time dateTime={event.occurredAt}>{event.occurredAt}</time>
							</li>
						))}
					</ul>
				)}
			</section>

			{state === "stale" && (
				<ViewState
					state="stale"
					message={`Last updated ${lastUpdated ? formatAge(lastUpdated) : "unknown"}`}
				/>
			)}
		</section>
	);
}

function formatAge(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
	return `${Math.floor(seconds / 3600)} hours ago`;
}
