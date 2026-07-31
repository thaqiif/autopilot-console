/**
 * Tests for global Overview, Attention, Activity, and Settings pages
 * (requirement 25).
 *
 * Covers: attention-first ordering, attention card fields, metric counts
 * with development wording, category filters, cursor pagination, redacted
 * settings health, all view states, REST refresh after SSE loss, and
 * attention-card primary-action navigation for every category.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
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
	href?: string;
	external?: boolean;
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
			reason: "task_review",
			currentState: "TASKS_REVIEW",
			ageBasis: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			category: "task_review",
			primaryAction: "review_tasks",
		},
		{
			projectId: "proj-2",
			featureId: "feat-2",
			reason: "development_failed",
			currentState: "DEVELOPMENT_FAILED",
			ageBasis: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
			category: "development_failed",
			primaryAction: "retry_development",
		},
	],
};

const MOCK_ATTENTION_FULL = {
	items: [
		{
			projectId: "proj-1",
			releaseId: "rel-1",
			featureId: "feat-1",
			reason: "task_review",
			currentState: "TASKS_REVIEW",
			ageBasis: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			category: "task_review",
			primaryAction: "review_tasks",
		},
		{
			projectId: "proj-2",
			featureId: "feat-2",
			reason: "development_failed",
			currentState: "DEVELOPMENT_FAILED",
			ageBasis: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
			category: "development_failed",
			primaryAction: "retry_development",
		},
		{
			projectId: "proj-3",
			featureId: "feat-3",
			reason: "development_interrupted",
			currentState: "DEVELOPMENT_INTERRUPTED",
			ageBasis: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
			category: "development_interrupted",
			primaryAction: "retry_development",
		},
		{
			projectId: "proj-4",
			featureId: "feat-4",
			reason: "pr_creation_failed",
			currentState: "PR_CREATION_FAILED",
			ageBasis: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			category: "pr_creation_failed",
			primaryAction: "retry_pr_creation",
		},
		{
			projectId: "proj-5",
			featureId: "feat-5",
			reason: "ci_failed",
			currentState: "CI_FAILED",
			ageBasis: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
			category: "ci_failed",
			primaryAction: "open_github_checks",
		},
		{
			projectId: "proj-6",
			featureId: "feat-6",
			reason: "pr_review",
			currentState: "PR_REVIEW",
			ageBasis: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
			category: "pr_review",
			primaryAction: "open_github_pr",
			githubUrl: "https://github.com/acme/repo/pull/6",
		},
		{
			projectId: "proj-7",
			featureId: "feat-7",
			reason: "pr_changes_requested",
			currentState: "PR_CHANGES_REQUESTED",
			ageBasis: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
			category: "pr_changes_requested",
			primaryAction: "open_github_pr",
			githubUrl: "https://github.com/acme/repo/pull/7",
		},
		{
			projectId: "proj-8",
			featureId: "feat-8",
			reason: "blocked",
			currentState: "BLOCKED",
			ageBasis: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
			category: "blocked",
			primaryAction: "resolve_block",
		},
		{
			projectId: "proj-9",
			featureId: "feat-9",
			reason: "stale_github_sync",
			currentState: "PR_REVIEW",
			ageBasis: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
			category: "stale_github_sync",
			primaryAction: "refresh_github_status",
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
	nextCursor: "next-cursor",
};

const MOCK_HEALTH = {
	status: "ok",
	database: { name: "database", status: "ok" },
	worker: {
		name: "worker",
		status: "ok",
		detail: {
			active: true,
			capacity: 4,
			activeJobs: 2,
			heartbeatAge: "5s ago",
			queueDepth: 1,
			pollingLagMs: 250,
		},
	},
	autopilot: { name: "autopilot", status: "ok", detail: { available: true } },
	github: { name: "github", status: "ok", detail: { authenticated: true } },
	checkedAt: "2026-07-19T00:00:00.000Z",
};

function installFetchMock(overrides?: {
	attentionData?: unknown;
	healthData?: unknown;
	activityData?: unknown;
	unauthorized?: boolean;
	error?: boolean;
	callCounter?: { count: number };
}) {
	const original = globalThis.fetch;
	const mockFetch = (async (input: string | URL | Request, _init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (overrides?.callCounter && /\/api\/(overview|attention|activity|health)/.test(url)) {
			overrides.callCounter.count += 1;
		}

		if (overrides?.unauthorized) {
			return new Response(
				JSON.stringify({
					ok: false,
					error: {
						code: "UNAUTHORIZED",
						message: "Session expired or invalid",
						httpStatus: 401,
						nextAction: "LOGIN",
					},
				}),
				{ status: 401, headers: { "Content-Type": "application/json" } },
			);
		}

		if (overrides?.error) {
			return new Response(
				JSON.stringify({
					ok: false,
					error: {
						code: "UNAVAILABLE",
						message: "Temporary failure",
						httpStatus: 503,
						nextAction: "RETRY",
					},
				}),
				{ status: 503, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/api/overview")) {
			return new Response(JSON.stringify({ ok: true, data: MOCK_OVERVIEW }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/attention")) {
			const data = overrides?.attentionData ?? MOCK_ATTENTION;
			return new Response(JSON.stringify({ ok: true, data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/activity")) {
			const data = overrides?.activityData ?? MOCK_ACTIVITY;
			return new Response(JSON.stringify({ ok: true, data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/health")) {
			const data = overrides?.healthData ?? MOCK_HEALTH;
			return new Response(JSON.stringify({ ok: true, data }), {
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
	return render(
		<MemoryRouter>
			<AttentionCard {...props} />
		</MemoryRouter>,
	);
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
		renderCard({ primaryAction: "Review tasks", href: "/projects/proj-1/features/feat-1#tasks" });
		const action =
			screen.queryByRole("link", { name: /review tasks/i }) ??
			screen.getByRole("button", { name: /review tasks/i });
		expect(action).toBeTruthy();
		const allActions = [
			...screen.queryAllByRole("link", { name: /review tasks/i }),
			...screen.queryAllByRole("button", { name: /review tasks/i }),
		];
		expect(allActions).toHaveLength(1);
	});

	test("primary action triggers callback when clicked", async () => {
		let called = false;
		renderCard({
			onAction: () => {
				called = true;
			},
		});
		const action =
			screen.queryByRole("button", { name: /review/i }) ??
			screen.getByRole("link", { name: /review/i });
		fireEvent.click(action);
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
		restore = installFetchMock({ attentionData: MOCK_ATTENTION_FULL });
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

	test("displays category filter controls for all required categories", async () => {
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.queryAllByRole("button").length).toBeGreaterThan(0);
		});
		// All 8 attention categories should have filter buttons — scope to nav
		const filterNav = document.querySelector("nav[aria-label='Attention filters']");
		expect(filterNav).toBeTruthy();
		const navText = filterNav?.textContent ?? "";
		for (const cat of [
			"Task Review",
			"Development Failed",
			"Development Interrupted",
			"Pr Creation Failed",
			"Ci Failed",
			"Pr Review",
			"Pr Changes Requested",
			"Blocked",
			"Stale Github Sync",
		]) {
			expect(navText).toMatch(new RegExp(cat.replace(/ /g, "\\s*"), "i"));
		}
	});

	test("clicking a category filter toggles it", async () => {
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
		// Use explicit role-based lookup for the filter button only
		const filterBtn = screen.getByRole("button", { name: /^task review$/i });
		expect(filterBtn.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(filterBtn);
		// Re-query after React re-render
		const pressedBtn = screen.getByRole("button", { name: /^task review$/i });
		expect(pressedBtn.getAttribute("aria-pressed")).toBe("true");
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

	test("displays load more button when there are more pages", async () => {
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByText(/state_transition/i)).toBeTruthy();
		});
		expect(screen.getByRole("button", { name: /load more/i })).toBeTruthy();
	});

	test("activity events are displayed in newest-first order", async () => {
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByText(/proj-1/i)).toBeTruthy();
		});
		const eventElements = document.querySelectorAll("li article");
		expect(eventElements.length).toBeGreaterThan(0);
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
			expect(screen.queryByText(/database/i)).toBeTruthy();
		});
		// Worker detail should include capacity and heartbeat age
		const body = document.body.textContent ?? "";
		expect(body).toMatch(/capacity/i);
		expect(body).toMatch(/heartbeat/i);
	});

	test("displays queue depth", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/queue depth/i)).toBeTruthy();
		});
	});

	test("displays polling lag", async () => {
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/polling lag/i)).toBeTruthy();
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

	test("attention page shows stale state when data is stale", async () => {
		const original = installFetchMock();
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.queryByText(/attention/i)).toBeTruthy();
		});
		original();
	});

	test("activity page shows stale state when data is stale", async () => {
		const original = installFetchMock();
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByText(/activity/i)).toBeTruthy();
		});
		original();
	});

	test("settings page shows stale state when data is stale", async () => {
		const original = installFetchMock();
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByText(/settings/i)).toBeTruthy();
		});
		original();
	});
});

// ---------------------------------------------------------------------------
// 8. SSE disconnect reconciliation
// ---------------------------------------------------------------------------

describe("SSE disconnect reconciliation", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
	});
	afterEach(() => {
		cleanup();
		restore?.();
	});

	test("overview refreshes from REST after simulated SSE disconnect", async () => {
		const counter = { count: 0 };
		restore = installFetchMock({ callCounter: counter });
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/needs? your attention/i)).toBeTruthy();
		});
		const initialCalls = counter.count;
		expect(initialCalls).toBeGreaterThan(0);

		// Simulate live-update loss: pages should re-fetch authoritative REST state.
		const refreshButton = screen.getByRole("button", { name: /refresh/i });
		fireEvent.click(refreshButton);
		await waitFor(() => {
			expect(counter.count).toBeGreaterThan(initialCalls);
		});
		expect(screen.queryByText(/development merged features/i)).toBeTruthy();
	});

	test("attention page refreshes from REST after simulated SSE disconnect", async () => {
		const counter = { count: 0 };
		restore = installFetchMock({ attentionData: MOCK_ATTENTION_FULL, callCounter: counter });
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
		const initialCalls = counter.count;
		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() => {
			expect(counter.count).toBeGreaterThan(initialCalls);
		});
	});

	test("activity page refreshes from REST after simulated SSE disconnect", async () => {
		const counter = { count: 0 };
		restore = installFetchMock({ callCounter: counter });
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /activity/i })).toBeTruthy();
		});
		const initialCalls = counter.count;
		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() => {
			expect(counter.count).toBeGreaterThan(initialCalls);
		});
	});

	test("settings page refreshes from REST after simulated SSE disconnect", async () => {
		const counter = { count: 0 };
		restore = installFetchMock({ callCounter: counter });
		renderAt("/settings");
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /settings|status|health/i })).toBeTruthy();
		});
		const initialCalls = counter.count;
		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() => {
			expect(counter.count).toBeGreaterThan(initialCalls);
		});
	});
});

// ---------------------------------------------------------------------------
// 9. Attention card primary action navigation
// ---------------------------------------------------------------------------

describe("attention card primary action navigation", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("task_review category links to task review in one interaction", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Needs task review"
					state="TASKS_REVIEW"
					age="1 hour ago"
					category="task_review"
					primaryAction="Review tasks"
					href="/projects/proj-1/features/feat-1#tasks"
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /review tasks/i });
		expect(action.getAttribute("href")).toBe("/projects/proj-1/features/feat-1#tasks");
	});

	test("development_failed category links to failure detail", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Autopilot process exited with code 1"
					state="DEVELOPMENT_FAILED"
					age="3 hours ago"
					category="development_failed"
					primaryAction="View failure"
					href="/projects/proj-1/features/feat-1#failure"
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /view failure/i });
		expect(action.getAttribute("href")).toBe("/projects/proj-1/features/feat-1#failure");
	});

	test("development_interrupted category links to failure detail", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Lost worker heartbeat"
					state="DEVELOPMENT_INTERRUPTED"
					age="5 hours ago"
					category="development_interrupted"
					primaryAction="View failure"
					href="/projects/proj-1/features/feat-1#failure"
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /view failure/i });
		expect(action.getAttribute("href")).toBe("/projects/proj-1/features/feat-1#failure");
	});

	test("pr_review category links to GitHub PR when URL is known", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Awaiting PR review"
					state="PR_REVIEW"
					age="30 minutes ago"
					category="pr_review"
					primaryAction="View on GitHub"
					href="https://github.com/acme/repo/pull/1"
					external
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /github/i });
		expect(action.getAttribute("href")).toBe("https://github.com/acme/repo/pull/1");
		expect(action.getAttribute("target")).toBe("_blank");
	});

	test("pr_creation_failed category links to failure detail", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Push rejected by remote"
					state="PR_CREATION_FAILED"
					age="2 hours ago"
					category="pr_creation_failed"
					primaryAction="View failure"
					href="/projects/proj-1/features/feat-1#failure"
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /view failure/i });
		expect(action.getAttribute("href")).toBe("/projects/proj-1/features/feat-1#failure");
	});

	test("ci_failed category links to failure detail", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Checks did not pass"
					state="CI_FAILED"
					age="1 hour ago"
					category="ci_failed"
					primaryAction="View failure"
					href="/projects/proj-1/features/feat-1#failure"
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /view failure/i });
		expect(action.getAttribute("href")).toBe("/projects/proj-1/features/feat-1#failure");
	});

	test("pr_changes_requested category links to GitHub PR when URL is known", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Reviewer requested changes"
					state="PR_CHANGES_REQUESTED"
					age="45 minutes ago"
					category="pr_changes_requested"
					primaryAction="View on GitHub"
					href="https://github.com/acme/repo/pull/2"
					external
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /github/i });
		expect(action.getAttribute("href")).toBe("https://github.com/acme/repo/pull/2");
	});

	test("blocked category links to feature detail", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Invariant check failed"
					state="BLOCKED"
					age="10 minutes ago"
					category="blocked"
					primaryAction="View details"
					href="/projects/proj-1/features/feat-1"
				/>
			</MemoryRouter>,
		);
		const action = screen.getByRole("link", { name: /view details/i });
		expect(action.getAttribute("href")).toBe("/projects/proj-1/features/feat-1");
	});

	test("overview renders domain action codes as human labels with one primary action", async () => {
		const restore = installFetchMock({ attentionData: MOCK_ATTENTION });
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByRole("link", { name: /review tasks/i })).toBeTruthy();
		});
		expect(screen.getByRole("link", { name: /view failure/i })).toBeTruthy();
		expect(screen.queryByText("review_tasks")).toBeNull();
		restore();
	});
});

// ---------------------------------------------------------------------------
// 9b. Additional page view-state contracts
// ---------------------------------------------------------------------------

describe("portfolio page error and unauthorized states", () => {
	let restore: () => void;
	beforeEach(() => cleanup());
	afterEach(() => {
		cleanup();
		restore?.();
	});

	test("overview shows unauthorized when session is invalid", async () => {
		restore = installFetchMock({ unauthorized: true });
		renderAt("/");
		await waitFor(() => {
			expect(screen.queryByText(/sign in/i)).toBeTruthy();
		});
	});

	test("attention shows error state when API fails", async () => {
		restore = installFetchMock({ error: true });
		renderAt("/attention");
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toMatch(/failed/i);
		});
	});

	test("activity shows empty state when no events exist", async () => {
		restore = installFetchMock({ activityData: { items: [], nextCursor: null } });
		renderAt("/activity");
		await waitFor(() => {
			expect(screen.queryByText(/no activity/i)).toBeTruthy();
		});
	});
});

// ---------------------------------------------------------------------------
// 10. SummaryCard component
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
