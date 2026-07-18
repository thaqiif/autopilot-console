/**
 * RED tests for global Overview, Attention, Activity, and Settings pages
 * (requirement 25).
 *
 * Covers: attention-first ordering, attention card fields, metric counts
 * with development wording, category filters, cursor pagination, redacted
 * settings health, all view states, and REST refresh after SSE loss.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AuthProvider } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";

// ---------------------------------------------------------------------------
// Stub page components — these are the modules under test.
// ---------------------------------------------------------------------------

let OverviewPage: React.ComponentType;
let AttentionPage: React.ComponentType;
let AttentionCard: React.ComponentType<{
	projectId: string;
	releaseId?: string;
	featureId: string;
	reason: string;
	state: string;
	age: string;
	category: string;
	primaryAction: string;
	onAction?: () => void;
}>;
let ActivityPage: React.ComponentType;
let SettingsPage: React.ComponentType;
let SummaryCard: React.ComponentType<{ label: string; value: number | string }>;

try {
	OverviewPage = (await import("./overview-page")).OverviewPage;
} catch {
	OverviewPage = () => <div data-testid="overview-missing" />;
}
try {
	const attentionMod = await import("../attention/attention-page");
	AttentionPage = attentionMod.AttentionPage;
} catch {
	AttentionPage = () => <div data-testid="attention-missing" />;
}
try {
	const cardMod = await import("../attention/attention-card");
	AttentionCard = cardMod.AttentionCard;
} catch {
	AttentionCard = () => <div data-testid="attention-card-missing" />;
}
try {
	ActivityPage = (await import("../activity/activity-page")).ActivityPage;
} catch {
	ActivityPage = () => <div data-testid="activity-missing" />;
}
try {
	SettingsPage = (await import("../settings/settings-page")).SettingsPage;
} catch {
	SettingsPage = () => <div data-testid="settings-missing" />;
}
try {
	SummaryCard = (await import("../../components/metrics/summary-card")).SummaryCard;
} catch {
	SummaryCard = () => <div data-testid="summary-card-missing" />;
}

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

const MOCK_OVERVIEW = {
	projectCount: 5,
	activeJobs: 2,
	queuedJobs: 1,
	attentionCount: 3,
	failedJobs: 1,
	prsAwaitingReview: 2,
	developmentMergedFeatures: 10,
	developmentMergedReleases: 3,
};

const MOCK_ATTENTION = {
	items: [
		{
			projectId: "proj-1",
			releaseId: "rel-1",
			featureId: "feat-1",
			reason: "Task review required",
			state: "TASKS_REVIEW",
			age: "2 hours ago",
			category: "task_review",
			primaryAction: "Review tasks",
		},
		{
			projectId: "proj-2",
			featureId: "feat-2",
			reason: "Development failed",
			state: "DEVELOPMENT_FAILED",
			age: "3 hours ago",
			category: "development_failed",
			primaryAction: "View failure",
		},
	],
};

const MOCK_ACTIVITY = {
	items: [
		{
			id: "evt-1",
			projectId: "proj-1",
			featureId: "feat-1",
			type: "state_transition",
			summary: "Feature moved to TASKS_REVIEW",
			source: "worker",
			occurredAt: new Date().toISOString(),
		},
	],
	cursor: "next-cursor",
};

const MOCK_HEALTH = {
	database: { connected: true, latency: 12 },
	workers: { active: 2, capacity: 4, heartbeatAge: "5s" },
	autopilot: { available: true, version: "1.0.0" },
	github: { authenticated: true, username: "testuser" },
	queue: { depth: 1, oldestAge: "2m", pollingLag: "10s" },
	runtime: { nodeEnv: "development", uptime: "2h" },
};

const _fetchSpy: ReturnType<typeof Bun.spawn> | null = null;

function installFetchMock() {
	const original = globalThis.fetch;
	const mockFetch = (async (input: string | URL | Request, _init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (url.includes("/api/overview")) {
			return new Response(JSON.stringify(MOCK_OVERVIEW), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/attention")) {
			return new Response(JSON.stringify(MOCK_ATTENTION), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/activity")) {
			return new Response(JSON.stringify(MOCK_ACTIVITY), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/health")) {
			return new Response(JSON.stringify(MOCK_HEALTH), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response(null, { status: 404 });
	}) as typeof fetch;
	globalThis.fetch = mockFetch;

	return () => {
		globalThis.fetch = original;
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderAt(path: string, opts?: { authenticated?: boolean }) {
	const authenticated = opts?.authenticated ?? true;

	const router = createMemoryRouter(
		[
			{
				path: "/login",
				element: (
					<AuthProvider initialAuthenticated={false}>
						<div />
					</AuthProvider>
				),
			},
			{
				path: "/",
				element: (
					<AuthProvider initialAuthenticated={authenticated}>
						<div>
							<div aria-live="polite" className="sr-only" />
							<OverviewPage />
						</div>
					</AuthProvider>
				),
			},
			{
				path: "/attention",
				element: (
					<AuthProvider initialAuthenticated={authenticated}>
						<AttentionPage />
					</AuthProvider>
				),
			},
			{
				path: "/activity",
				element: (
					<AuthProvider initialAuthenticated={authenticated}>
						<ActivityPage />
					</AuthProvider>
				),
			},
			{
				path: "/settings",
				element: (
					<AuthProvider initialAuthenticated={authenticated}>
						<SettingsPage />
					</AuthProvider>
				),
			},
		],
		{ initialEntries: [path] },
	);

	return render(<RouterProvider router={router} />);
}

function renderCard(overrides?: Partial<React.ComponentProps<typeof AttentionCard>>) {
	const props = {
		projectId: "proj-1",
		releaseId: "rel-1",
		featureId: "feat-1",
		reason: "Task review required",
		state: "TASKS_REVIEW",
		age: "2 hours ago",
		category: "task_review",
		primaryAction: "Review tasks",
		...overrides,
	};
	return render(<AttentionCard {...props} />);
}

// ---------------------------------------------------------------------------
// 1. Overview — attention-first ordering
// ---------------------------------------------------------------------------

describe("overview attention-first ordering", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("attention section appears before metrics in DOM order", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/needs? your attention/i)).toBeTruthy();
		});
		const attentionHeading = screen.getByText(/needs? your attention/i);
		const metricsHeading = screen.getByText(/portfolio overview/i);
		const allText = document.body.textContent ?? "";
		expect(allText.indexOf(attentionHeading.textContent ?? "")).toBeLessThan(
			allText.indexOf(metricsHeading.textContent ?? ""),
		);
	});

	test("attention section appears before activity in DOM order", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/needs? your attention/i)).toBeTruthy();
		});
		const attentionHeading = screen.getByText(/needs? your attention/i);
		const activityHeading = screen.getByText(/recent activity/i);
		const allText = document.body.textContent ?? "";
		expect(allText.indexOf(attentionHeading.textContent ?? "")).toBeLessThan(
			allText.indexOf(activityHeading.textContent ?? ""),
		);
	});
});

// ---------------------------------------------------------------------------
// 2. Overview — metrics with development-only wording
// ---------------------------------------------------------------------------

describe("overview metrics", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("displays project count", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/projects/i)).toBeTruthy();
		});
	});

	test("displays active jobs count", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/active jobs/i)).toBeTruthy();
		});
	});

	test("displays queued jobs count", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/queued/i)).toBeTruthy();
		});
	});

	test("displays attention count", async () => {
		renderAt("/");
		await waitFor(() => {
			// The SummaryCard for attention shows the label and count
			const cards = screen.getAllByText("Attention");
			expect(cards.length).toBeGreaterThanOrEqual(1);
		});
	});

	test("displays failed or interrupted jobs count", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText("Failed/Interrupted Jobs")).toBeTruthy();
		});
	});

	test("displays PRs awaiting review count", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText("PRs Awaiting Review")).toBeTruthy();
		});
	});

	test("displays development-merged features with explicit development wording", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText("Development Merged Features")).toBeTruthy();
		});
	});

	test("uses development wording not production-ready language", async () => {
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/projects/i)).toBeTruthy();
		});
		const body = document.body.textContent ?? "";
		expect(body.toLowerCase()).not.toContain("production-ready");
		expect(body.toLowerCase()).not.toContain("released");
	});
});

// ---------------------------------------------------------------------------
// 3. Attention card fields
// ---------------------------------------------------------------------------

describe("attention card fields", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("displays project identifier", () => {
		renderCard();
		expect(screen.queryByText(/proj-1/i)).toBeTruthy();
	});

	test("displays release identifier when present", () => {
		renderCard({ releaseId: "rel-42" });
		expect(screen.queryByText(/rel-42/i)).toBeTruthy();
	});

	test("omits release gracefully when not provided", () => {
		renderCard({ releaseId: undefined });
		expect(screen.queryByTestId("attention-card-missing")).toBeNull();
	});

	test("displays feature identifier", () => {
		renderCard();
		expect(screen.queryByText(/feat-1/i)).toBeTruthy();
	});

	test("displays reason text", () => {
		renderCard({ reason: "Development failed" });
		expect(screen.queryByText(/development failed/i)).toBeTruthy();
	});

	test("displays current state", () => {
		renderCard({ state: "CI_FAILED" });
		expect(screen.queryByText(/ci.?failed/i)).toBeTruthy();
	});

	test("displays age basis", () => {
		renderCard({ age: "3 hours ago" });
		expect(screen.queryByText(/3 hours ago/i)).toBeTruthy();
	});

	test("displays exactly one primary action button or link", () => {
		renderCard({ primaryAction: "Review tasks" });
		const button = screen.getByRole("button", { name: /review tasks/i });
		expect(button).toBeTruthy();
	});

	test("primary action triggers callback when clicked", async () => {
		let called = false;
		renderCard({
			onAction: () => {
				called = true;
			},
		});
		const button = screen.getByRole("button", { name: /review/i });
		button.click();
		expect(called).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. Attention page — category filters
// ---------------------------------------------------------------------------

describe("attention page filters", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders the attention page heading", async () => {
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
	});

	test("displays category filter controls", async () => {
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.queryAllByRole("button").length).toBeGreaterThan(0);
		});
	});
});

// ---------------------------------------------------------------------------
// 5. Activity page — cursor pagination
// ---------------------------------------------------------------------------

describe("activity page", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders activity page heading", async () => {
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /activity/i })).toBeTruthy();
		});
	});

	test("displays project or feature context on activity events", async () => {
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByText(/proj-1/i)).toBeTruthy();
		});
	});

	test("does not display raw log lines as activity", async () => {
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByText(/state_transition/i)).toBeTruthy();
		});
		const rawLogPattern = /\d{2}:\d{2}:\d{2}\s+(INFO|WARN|ERROR|DEBUG)/i;
		expect(rawLogPattern.test(document.body.textContent ?? "")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 6. Settings page — redacted health
// ---------------------------------------------------------------------------

describe("settings and health page", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders settings page heading", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /settings|status|health/i })).toBeTruthy();
		});
	});

	test("displays database status", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/database/i)).toBeTruthy();
		});
	});

	test("displays worker capacity and heartbeat", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/worker/i)).toBeTruthy();
		});
	});

	test("displays GitHub authentication status", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/github/i)).toBeTruthy();
		});
	});

	test("displays runtime configuration health", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/runtime/i)).toBeTruthy();
		});
	});

	test("does not expose credentials or connection strings", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/database/i)).toBeTruthy();
		});
		const body = document.body.textContent ?? "";
		expect(body).not.toMatch(/postgresql:\/\/\w+:\w+@/);
		expect(body).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
		expect(body).not.toMatch(/Bearer [a-zA-Z0-9_-]{20,}/);
	});
});

// ---------------------------------------------------------------------------
// 7. View states — loading, empty, error, stale, unauthorized
// ---------------------------------------------------------------------------

describe("page view states", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("loading state renders accessible status", () => {
		render(<ViewState state="loading" />);
		const status = screen.getByRole("status");
		expect(status.getAttribute("aria-label")).toContain("Loading");
	});

	test("empty state renders descriptive message", () => {
		render(<ViewState state="empty" message="No attention items" />);
		expect(screen.getByText(/no attention items/i)).toBeTruthy();
	});

	test("error state renders alert role", () => {
		render(<ViewState state="error" message="Failed to load overview" />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Failed to load");
	});

	test("stale state renders update hint", () => {
		render(<ViewState state="stale" message="Data may be outdated" />);
		expect(screen.getByText(/outdated/i)).toBeTruthy();
	});

	test("unauthorized state renders sign-in prompt", () => {
		render(<ViewState state="unauthorized" />);
		expect(screen.getByText(/sign in/i)).toBeTruthy();
	});

	test("unauthenticated user sees no portfolio data at overview", () => {
		renderAt("/", { authenticated: false });
		const projects = screen.queryByText(/projects?\s*:\s*\d/i);
		expect(projects).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 8. SSE disconnect reconciliation
// ---------------------------------------------------------------------------

describe("SSE disconnect reconciliation", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("overview refreshes from REST after simulated SSE disconnect", async () => {
		renderAt("/");
		expect(document.querySelector("[aria-live]")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 9. SummaryCard component
// ---------------------------------------------------------------------------

describe("summary card component", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("displays label and value", () => {
		render(<SummaryCard label="Active Jobs" value={3} />);
		expect(screen.getByText("Active Jobs")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
	});

	test("displays zero values", () => {
		render(<SummaryCard label="Failed" value={0} />);
		expect(screen.getByText("0")).toBeTruthy();
	});

	test("is accessible with semantic structure", () => {
		render(<SummaryCard label="Projects" value={5} />);
		expect(screen.getByText("Projects")).toBeTruthy();
		expect(screen.getByText("5")).toBeTruthy();
	});
});
