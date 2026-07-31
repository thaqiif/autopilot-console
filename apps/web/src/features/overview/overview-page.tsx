import { useCallback, useEffect, useState } from "react";
import { isUnauthorized } from "../../api/result";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";
import { SummaryCard } from "../../components/metrics/summary-card";
import { formatRelativeTime, LocalDateTime } from "../../time/local-date-time";
import { AttentionCard } from "../attention/attention-card";
import { type AttentionItemInput, toAttentionCardModel } from "../attention/attention-model";

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

interface ActivityEvent {
	id: string;
	projectId?: string | null;
	featureId?: string | null;
	type: string;
	summary: string;
	occurredAt: string;
}

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

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
	const { client } = useAuth();
	const [metrics, setMetrics] = useState<OverviewMetrics>(DEFAULT_METRICS);
	const [attention, setAttention] = useState<ReturnType<typeof toAttentionCardModel>[]>([]);
	const [activity, setActivity] = useState<ActivityEvent[]>([]);
	const [state, setState] = useState<PageState>("loading");
	const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

	const loadData = useCallback(async () => {
		try {
			const [metricsRes, attentionRes, activityRes] = await Promise.all([
				client.get<OverviewMetrics>("/api/overview"),
				client.get<{ items: AttentionItemInput[] }>("/api/attention"),
				client.get<{ items: ActivityEvent[] }>("/api/activity?limit=5"),
			]);

			if (
				isUnauthorized(metricsRes) ||
				isUnauthorized(attentionRes) ||
				isUnauthorized(activityRes)
			) {
				setState("unauthorized");
				return;
			}

			if (!metricsRes.ok || !attentionRes.ok || !activityRes.ok) {
				setState("error");
				return;
			}

			setMetrics(metricsRes.data);
			setAttention(attentionRes.data.items.map(toAttentionCardModel));
			setActivity(activityRes.data.items);
			setLastUpdated(new Date());
			setState("ready");
		} catch {
			setState("error");
		}
	}, [client]);

	useEffect(() => {
		void loadData();
	}, [loadData]);

	useSseRestRefresh(loadData, {
		onStale: () => setState((current) => (current === "ready" ? "stale" : current)),
	});

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error") return <ViewState state="error" message="Failed to load overview" />;

	return (
		<section aria-label="Portfolio overview">
			<header className="page-header">
				<div>
					<h1 className="sr-only">Overview</h1>
				</div>
				<button type="button" onClick={() => void loadData()}>
					Refresh
				</button>
			</header>

			<section aria-label="Needs your attention">
				<h2>Needs Your Attention</h2>
				{attention.length === 0 ? (
					<ViewState state="empty" message="No attention items" />
				) : (
					<ul>
						{attention.map((item) => (
							<li key={`${item.projectId}:${item.featureId}:${item.category}`}>
								<AttentionCard
									projectId={item.projectId}
									releaseId={item.releaseId}
									featureId={item.featureId}
									reason={item.reason}
									state={item.state}
									age={item.age}
									category={item.category}
									primaryAction={item.primaryAction}
									href={item.href}
									external={item.external}
								/>
							</li>
						))}
					</ul>
				)}
			</section>

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
								{event.projectId ? <span>{event.projectId}</span> : null}
								{event.featureId ? <span>{event.featureId}</span> : null}
								<LocalDateTime utc={event.occurredAt} format="relative" showTimezone />
							</li>
						))}
					</ul>
				)}
			</section>

			{state === "stale" && (
				<ViewState
					state="stale"
					message={`Last updated ${lastUpdated ? formatRelativeTime(lastUpdated) : "unknown"}`}
				/>
			)}
		</section>
	);
}
