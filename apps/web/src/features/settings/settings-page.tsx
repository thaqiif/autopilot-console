import { useCallback, useEffect, useState } from "react";
import { isUnauthorized } from "../../api/result";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";
import { LocalDateTime } from "../../time/local-date-time";

/** Production health component status from /api/health (req 22/30). */
type ComponentStatus = "ok" | "degraded" | "down";

interface HealthComponent {
	name: string;
	status: ComponentStatus;
	detail?: Record<string, unknown>;
}

/** Redacted readiness report — same contract as createProductionHealthProbes. */
interface HealthStatus {
	status: ComponentStatus;
	database: HealthComponent;
	worker: HealthComponent;
	autopilot: HealthComponent;
	github: HealthComponent;
	checkedAt: string;
}

type PageState = "loading" | "ready" | "error" | "stale" | "unauthorized";

/** Accessible status token: text + data-status, never color alone. */
type AccessibleStatus = "healthy" | "degraded" | "unavailable";

function toAccessibleStatus(status: ComponentStatus | undefined): AccessibleStatus {
	if (status === "ok") return "healthy";
	if (status === "degraded") return "degraded";
	return "unavailable";
}

function formatMetric(value: unknown): string {
	if (value === undefined || value === null || value === "") return "unavailable";
	if (typeof value === "number" && !Number.isFinite(value)) return "unavailable";
	return String(value);
}

function StatusValue({ status }: { status: ComponentStatus | undefined }) {
	const accessible = toAccessibleStatus(status);
	return <span data-status={accessible}>{accessible}</span>;
}

function MetricRow({ label, value }: { label: string; value: unknown }) {
	const text = formatMetric(value);
	const unavailable = text === "unavailable";
	return (
		<>
			<dt>{label}</dt>
			<dd>{unavailable ? <span data-status="unavailable">unavailable</span> : text}</dd>
		</>
	);
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

	useSseRestRefresh(loadHealth, {
		onStale: () => setState((current) => (current === "ready" ? "stale" : current)),
	});

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "unauthorized") return <ViewState state="unauthorized" />;
	if (state === "error") return <ViewState state="error" message="Failed to load health status" />;

	const workerDetail = health?.worker?.detail ?? {};

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
				<dd>
					<StatusValue status={health?.database?.status} />
				</dd>

				<dt>Worker</dt>
				<dd>
					<StatusValue status={health?.worker?.status} />
				</dd>

				<MetricRow label="Worker Capacity" value={workerDetail.capacity} />
				<MetricRow label="Active Jobs" value={workerDetail.activeJobs} />
				<MetricRow label="Worker Heartbeat" value={workerDetail.heartbeatAge} />
				<MetricRow label="Queue Depth" value={workerDetail.queueDepth} />
				<MetricRow label="Oldest Queued Age" value={workerDetail.oldestQueuedAgeMs} />
				<MetricRow label="Polling Lag" value={workerDetail.pollingLagMs} />

				<dt>GitHub</dt>
				<dd>
					<StatusValue status={health?.github?.status} />
				</dd>

				<dt>Autopilot</dt>
				<dd>
					<StatusValue status={health?.autopilot?.status} />
				</dd>

				<dt>Runtime health</dt>
				<dd>
					<StatusValue status={health?.status} />
				</dd>

				<dt>Checked at</dt>
				<dd>
					{health?.checkedAt ? (
						<LocalDateTime utc={health.checkedAt} showTimezone />
					) : (
						"unavailable"
					)}
				</dd>
			</dl>

			{state === "stale" ? <ViewState state="stale" message="Data may be outdated" /> : null}
		</section>
	);
}
