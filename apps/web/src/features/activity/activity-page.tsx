import { useCallback, useEffect, useState } from "react";
import { ViewState } from "../../components/feedback/view-state";

interface ActivityEvent {
	id: string;
	projectId?: string;
	featureId?: string;
	type: string;
	summary: string;
	source: string;
	occurredAt: string;
}

export function ActivityPage() {
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	const loadActivity = useCallback(async (pageCursor?: string) => {
		try {
			const url = pageCursor ? `/api/activity?cursor=${pageCursor}` : "/api/activity";
			const res = await fetch(url, { credentials: "include" });
			if (res.status === 401) {
				setState("error");
				return;
			}
			if (res.ok) {
				const data = await res.json();
				const items: ActivityEvent[] = data.items ?? [];
				setEvents((prev) => (pageCursor ? [...prev, ...items] : items));
				setCursor(data.cursor ?? null);
				setHasMore(!!data.cursor);
			}
			setState("ready");
		} catch {
			setState("error");
		}
	}, []);

	useEffect(() => {
		loadActivity();
	}, [loadActivity]);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Failed to load activity" />;

	return (
		<section aria-label="Activity">
			<h1>Activity</h1>

			{events.length === 0 ? (
				<ViewState state="empty" message="No activity events" />
			) : (
				<ul>
					{events.map((event) => (
						<li key={event.id}>
							<article>
								<header>
									<span>{event.type}</span>
									{event.projectId && <span>{event.projectId}</span>}
									{event.featureId && <span>{event.featureId}</span>}
								</header>
								<p>{event.summary}</p>
								<time dateTime={event.occurredAt}>
									{new Date(event.occurredAt).toLocaleString()}
								</time>
							</article>
						</li>
					))}
				</ul>
			)}

			{hasMore && (
				<button type="button" onClick={() => loadActivity(cursor ?? undefined)}>
					Load more
				</button>
			)}
		</section>
	);
}
