type ViewStatus = "loading" | "empty" | "error" | "stale" | "unauthorized";

export interface ViewStateProps {
	state: ViewStatus;
	message?: string;
}

export function ViewState({ state, message }: ViewStateProps) {
	switch (state) {
		case "loading":
			return (
				<div role="status" aria-live="polite" aria-label="Loading">
					<span aria-hidden="true" />
					<p>Loading...</p>
				</div>
			);
		case "empty":
			return (
				<div role="status" aria-live="polite">
					<p>{message ?? "No data"}</p>
				</div>
			);
		case "error":
			return (
				<div role="alert" aria-live="assertive" aria-label="Error">
					<p>{message ?? "An error occurred"}</p>
				</div>
			);
		case "stale":
			return (
				<div role="status" aria-live="polite">
					<p>{message ?? "Data may be outdated"}</p>
				</div>
			);
		case "unauthorized":
			return (
				<div role="status" aria-live="polite">
					<p>Please sign in to continue</p>
				</div>
			);
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}
