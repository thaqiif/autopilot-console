import { useEffect, useState } from "react";
import { ViewState } from "../../components/feedback/view-state";

interface HealthStatus {
	database: { connected: boolean; latency: number };
	workers: { active: number; capacity: number; heartbeatAge: string };
	autopilot: { available: boolean; version: string };
	github: { authenticated: boolean; username: string };
	queue: { depth: number; oldestAge: string; pollingLag: string };
	runtime: { nodeEnv: string; uptime: string };
}

export function SettingsPage() {
	const [health, setHealth] = useState<HealthStatus | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		async function loadHealth() {
			try {
				const res = await fetch("/api/health", { credentials: "include" });
				if (res.status === 401) {
					setState("error");
					return;
				}
				if (res.ok) {
					setHealth(await res.json());
				}
				setState("ready");
			} catch {
				setState("error");
			}
		}
		loadHealth();
	}, []);

	if (state === "loading") return <ViewState state="loading" />;
	if (state === "error") return <ViewState state="error" message="Failed to load health status" />;

	return (
		<section aria-label="Settings and health">
			<h1>Settings &amp; Status</h1>

			<dl>
				<dt>Database</dt>
				<dd>{health?.database.connected ? "Connected" : "Disconnected"}</dd>

				<dt>Worker</dt>
				<dd>
					{health?.workers.active ?? 0} / {health?.workers.capacity ?? 0} active
				</dd>

				<dt>GitHub</dt>
				<dd>
					{health?.github.authenticated
						? `Authenticated as ${health.github.username}`
						: "Not authenticated"}
				</dd>

				<dt>Autopilot</dt>
				<dd>
					{health?.autopilot.available ? `Available (${health.autopilot.version})` : "Unavailable"}
				</dd>

				<dt>Queue Depth</dt>
				<dd>{health?.queue.depth ?? 0}</dd>

				<dt>Runtime</dt>
				<dd>
					{health?.runtime.nodeEnv} — uptime {health?.runtime.uptime}
				</dd>
			</dl>
		</section>
	);
}
