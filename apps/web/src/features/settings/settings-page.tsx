import { useCallback, useEffect, useState } from "react";
import { createSseClient } from "../../api/sse";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";
import { formatLocalDateTime } from "../../time/local-date-time";

interface HealthStatus {
	status: "ok" | "degraded" | "down";
	database: HealthComponent;
	worker: HealthComponent;
	autopilot: HealthComponent;
	github: HealthComponent;
	checkedAt: string;
}

interface HealthComponent {
	name: string;
	status: "ok" | "degraded" | "down";
	detail?: Record<string, unknown>;
}

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

function isUnauthorized(result: { ok: boolean; error?: { code?: string; httpStatus?: number } }) {
	return !result.ok && (result.error?.code === "UNAUTHORIZED" || result.error?.httpStatus === 401);
}

function detailValue(detail: Record<string, unknown> | undefined, key: string): string {
	if (!detail || detail[key] === undefined || detail[key] === null) return "unknown";
	return String(detail[key]);
}

export function SettingsPage() {
	const { client } = useAuth();
	const [health, setHealth] = useState<HealthStatus | null>(null);
	const [state, setState] = useState<PageState>("loading");

	const loadHealth = useCallback(async () => {
		try {
			const res = await client.get<HealthStatus>("/api/health");
			if (isUnauthorized(res)) {
				setState("unauthorized");
				return;
			}
			if (!res.ok) {
				setState("error");
				return;
			}
			setHealth(res.data);
			setState("ready");
		} catch {
			setState("error");
		}
	}, [client]);

	useEffect(() => {
		void loadHealth();
	}, [loadHealth]);

	useEffect(() => {
		const sse = createSseClient({
			url: "/api/events",
			onDisconnect: () => {
				setState((current) => (current === "ready" ? "stale" : current));
				void loadHealth();
			},
		});
		sse.connect();
		return () => sse.close();
	}, [loadHealth]);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error") return <ViewState state="error" message="Failed to load health status" />;

	const workerDetail = health?.worker?.detail ?? {};
	const workerCapacity = detailValue(workerDetail, "capacity");
	const workerHeartbeat = detailValue(workerDetail, "heartbeatAge");
	const queueDepth = detailValue(workerDetail, "queueDepth");
	const pollingLagRaw = workerDetail.pollingLagMs;
	const pollingLag =
		pollingLagRaw === undefined || pollingLagRaw === null
			? "unknown"
			: `${String(pollingLagRaw)}ms`;

	return (
		<section aria-label="Settings and health">
			<header className="page-header">
				<h1>Settings &amp; Status</h1>
				<button type="button" onClick={() => void loadHealth()}>
					Refresh
				</button>
			</header>

			<dl>
				<dt>Database</dt>
				<dd>{health?.database?.status ?? "unknown"}</dd>

				<dt>Worker</dt>
				<dd>{health?.worker?.status ?? "unknown"}</dd>

				<dt>Worker Capacity</dt>
				<dd>{workerCapacity}</dd>

				<dt>Worker Heartbeat</dt>
				<dd>{workerHeartbeat}</dd>

				<dt>Queue Depth</dt>
				<dd>{queueDepth}</dd>

				<dt>Polling Lag</dt>
				<dd>{pollingLag}</dd>

				<dt>GitHub</dt>
				<dd>{health?.github?.status ?? "unknown"}</dd>

				<dt>Autopilot</dt>
				<dd>{health?.autopilot?.status ?? "unknown"}</dd>

				<dt>Runtime health</dt>
				<dd>{health?.status ?? "unknown"}</dd>

				<dt>Checked at</dt>
				<dd>{health?.checkedAt ? formatLocalDateTime(health.checkedAt) : "unknown"}</dd>
			</dl>

			{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
		</section>
	);
}
