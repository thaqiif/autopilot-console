import { useEffect, useState } from "react";
import { ViewState } from "../../components/feedback/view-state";
import { AttentionCard } from "./attention-card";

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

const CATEGORIES = [
	"task_review",
	"development_failed",
	"development_interrupted",
	"pr_creation_failed",
	"ci_failed",
	"pr_review",
	"pr_changes_requested",
	"blocked",
] as const;

export function AttentionPage() {
	const [items, setItems] = useState<AttentionItem[]>([]);
	const [filter, setFilter] = useState<string | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		async function loadAttention() {
			try {
				const url = filter ? `/api/attention?category=${filter}` : "/api/attention";
				const res = await fetch(url, { credentials: "include" });
				if (res.status === 401) {
					setState("error");
					return;
				}
				if (res.ok) {
					const data = await res.json();
					setItems(data.items ?? []);
				}
				setState("ready");
			} catch {
				setState("error");
			}
		}
		loadAttention();
	}, [filter]);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error")
		return <ViewState state="error" message="Failed to load attention items" />;

	return (
		<section aria-label="Attention">
			<h1>Needs Your Attention</h1>

			<nav aria-label="Attention filters">
				{CATEGORIES.map((cat) => (
					<button
						key={cat}
						type="button"
						aria-pressed={filter === cat}
						onClick={() => setFilter(filter === cat ? null : cat)}
					>
						{formatCategory(cat)}
					</button>
				))}
			</nav>

			{items.length === 0 ? (
				<ViewState state="empty" message="No attention items" />
			) : (
				<ul>
					{items.map((item) => (
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
	);
}

function formatCategory(cat: string): string {
	return cat
		.split("_")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}
