type ViewStatus = "loading" | "empty" | "error" | "stale" | "unauthorized";

export interface ViewStateProps {
	state: ViewStatus;
	message?: string;
}

const STATE_META: Record<ViewStatus, { label: string; icon: string; role: "status" | "alert" }> = {
	loading: { label: "Loading", icon: "…", role: "status" },
	empty: { label: "Empty", icon: "○", role: "status" },
	error: { label: "Error", icon: "!", role: "alert" },
	stale: { label: "Stale", icon: "↻", role: "status" },
	unauthorized: { label: "Unauthorized", icon: "⌀", role: "status" },
};

export function ViewState({ state, message }: ViewStateProps) {
	const meta = STATE_META[state];
	const text =
		message ??
		(state === "loading"
			? "Loading..."
			: state === "empty"
				? "No data"
				: state === "error"
					? "An error occurred"
					: state === "stale"
						? "Data may be outdated"
						: "Please sign in to continue");

	// Icon + role + text (never color alone). Label is decorative; text carries the meaning.
	return (
		<div
			role={meta.role}
			aria-live={meta.role === "alert" ? "assertive" : "polite"}
			data-view-state={state}
			className="view-state"
		>
			<span className="view-state-icon" aria-hidden="true" title={meta.label}>
				{meta.icon}
			</span>
			<p>{text}</p>
		</div>
	);
}
