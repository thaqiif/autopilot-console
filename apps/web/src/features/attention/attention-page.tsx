import { useCallback, useEffect, useState } from "react";
import { createSseClient } from "../../api/sse";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";
import { formatRelativeTime } from "../../time/local-date-time";
import { AttentionCard } from "./attention-card";
import {
	ATTENTION_CATEGORY_ORDER,
	type AttentionItemInput,
	formatAttentionCategory,
	toAttentionCardModel,
} from "./attention-model";

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

function isUnauthorized(result: { ok: boolean; error?: { code?: string; httpStatus?: number } }) {
	return !result.ok && (result.error?.code === "UNAUTHORIZED" || result.error?.httpStatus === 401);
}

export function AttentionPage() {
	const { client } = useAuth();
	const [items, setItems] = useState<ReturnType<typeof toAttentionCardModel>[]>([]);
	const [filter, setFilter] = useState<string | null>(null);
	const [state, setState] = useState<PageState>("loading");

	const loadAttention = useCallback(async () => {
		try {
			const url = filter ? `/api/attention?category=${filter}` : "/api/attention";
			const res = await client.get<{ items: AttentionItemInput[] }>(url);
			if (isUnauthorized(res)) {
				setState("unauthorized");
				return;
			}
			if (!res.ok) {
				setState("error");
				return;
			}
			setItems(
				res.data.items.map((item) => {
					const model = toAttentionCardModel(item);
					return {
						...model,
						age: item.age ?? formatRelativeTime(item.ageBasis ?? model.age),
					};
				}),
			);
			setState("ready");
		} catch {
			setState("error");
		}
	}, [client, filter]);

	useEffect(() => {
		void loadAttention();
	}, [loadAttention]);

	useEffect(() => {
		const sse = createSseClient({
			url: "/api/events",
			onDisconnect: () => {
				setState((current) => (current === "ready" ? "stale" : current));
				void loadAttention();
			},
		});
		sse.connect();
		return () => sse.close();
	}, [loadAttention]);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error")
		return <ViewState state="error" message="Failed to load attention items" />;

	return (
		<section aria-label="Attention">
			<header className="page-header">
				<h1>Needs Your Attention</h1>
				<button type="button" onClick={() => void loadAttention()}>
					Refresh
				</button>
			</header>

			<nav aria-label="Attention filters">
				{ATTENTION_CATEGORY_ORDER.map((cat) => (
					<button
						key={cat}
						type="button"
						aria-pressed={filter === cat}
						onClick={() => setFilter(filter === cat ? null : cat)}
					>
						{formatAttentionCategory(cat)}
					</button>
				))}
			</nav>

			{items.length === 0 ? (
				<ViewState state="empty" message="No attention items" />
			) : (
				<ul>
					{items.map((item) => (
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

			{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
		</section>
	);
}
