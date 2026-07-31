import { useCallback, useEffect, useState } from "react";
import { isUnauthorized } from "../../api/result";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";
import { formatLocalDateTime, formatRelativeTime } from "../../time/local-date-time";

interface ActivityEvent {
	id: string;
	projectId?: string | null;
	featureId?: string | null;
	type: string;
	summary: string;
	source: string;
	occurredAt: string;
}

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

export function ActivityPage() {
	const { client } = useAuth();
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [state, setState] = useState<PageState>("loading");

	const loadActivity = useCallback(
		async (pageCursor?: string) => {
			try {
				const url = pageCursor ? `/api/activity?cursor=${pageCursor}` : "/api/activity";
				const res = await client.get<{
					items: ActivityEvent[];
					nextCursor?: string | null;
					cursor?: string | null;
				}>(url);
				if (isUnauthorized(res)) {
					setState("unauthorized");
					return;
				}
				if (!res.ok) {
					setState("error");
					return;
				}
				const next = res.data.nextCursor ?? res.data.cursor ?? null;
				setEvents((prev) => (pageCursor ? [...prev, ...res.data.items] : res.data.items));
				setCursor(next);
				setHasMore(next !== null);
				setState("ready");
			} catch {
				setState("error");
			}
		},
		[client],
	);

	const refreshFromStart = useCallback(() => {
		void loadActivity();
	}, [loadActivity]);

	useEffect(() => {
		void loadActivity();
	}, [loadActivity]);

	useSseRestRefresh(refreshFromStart, {
		onStale: () => setState((current) => (current === "ready" ? "stale" : current)),
	});

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error") return <ViewState state="error" message="Failed to load activity" />;

	return (
		<section aria-label="Activity">
			<header className="page-header">
				<h1>Activity</h1>
				<button type="button" onClick={refreshFromStart}>
					Refresh
				</button>
			</header>

			{events.length === 0 ? (
				<ViewState state="empty" message="No activity events" />
			) : (
				<ul>
					{events.map((event) => (
						<li key={event.id}>
							<article>
								<header>
									<span>{event.type}</span>
									{event.projectId ? <span>{event.projectId}</span> : null}
									{event.featureId ? <span>{event.featureId}</span> : null}
								</header>
								<p>{event.summary}</p>
								<time dateTime={event.occurredAt} title={formatLocalDateTime(event.occurredAt)}>
									{formatRelativeTime(event.occurredAt)}
								</time>
							</article>
						</li>
					))}
				</ul>
			)}

			{hasMore ? (
				<button type="button" onClick={() => void loadActivity(cursor ?? undefined)}>
					Load more
				</button>
			) : null}

			{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
		</section>
	);
}
