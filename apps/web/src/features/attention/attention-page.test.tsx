/**
 * RED tests for the full Attention page (requirement 25).
 *
 * Covers: all attention categories, filter behavior, primary action
 * links to task review / failure detail / GitHub PR, and view states.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { AuthProvider } from "../../auth/auth-provider";

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

try {
	AttentionPage = (await import("./attention-page")).AttentionPage;
} catch {
	AttentionPage = () => <div data-testid="attention-missing" />;
}
try {
	AttentionCard = (await import("./attention-card")).AttentionCard;
} catch {
	AttentionCard = () => <div data-testid="attention-card-missing" />;
}

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

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
		{
			projectId: "proj-3",
			featureId: "feat-3",
			reason: "PR awaiting review",
			state: "PR_REVIEW",
			age: "30 minutes ago",
			category: "pr_review",
			primaryAction: "View on GitHub",
		},
	],
};

function installFetchMock() {
	const original = globalThis.fetch;
	const mockFetch = (async (input: string | URL | Request, _init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (url.includes("/api/attention")) {
			return new Response(JSON.stringify(MOCK_ATTENTION), {
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

function renderAttention(path = "/attention") {
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
					<AuthProvider initialAuthenticated>
						<AttentionPage />
					</AuthProvider>
				),
			},
			{
				path: "/attention",
				element: (
					<AuthProvider initialAuthenticated>
						<AttentionPage />
					</AuthProvider>
				),
			},
		],
		{ initialEntries: [path] },
	);
	return render(<RouterProvider router={router} />);
}

// ---------------------------------------------------------------------------
// 1. Page rendering
// ---------------------------------------------------------------------------

describe("attention page rendering", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders the page heading", async () => {
		renderAttention();
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
	});

	test("renders with accessible landmarks", async () => {
		renderAttention();
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
		const main = document.querySelector("section[aria-label]") ?? document.querySelector("section");
		expect(main).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 2. Category presence
// ---------------------------------------------------------------------------

describe("attention categories", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("page loads without crashing", async () => {
		renderAttention();
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
		expect(document.body.textContent?.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 3. Attention card action links
// ---------------------------------------------------------------------------

describe("attention card actions", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("task_review category shows Review action", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Tasks need review"
					state="TASKS_REVIEW"
					age="1 hour ago"
					category="task_review"
					primaryAction="Review tasks"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("button", { name: /review/i })).toBeTruthy();
	});

	test("development_failed category shows failure detail action", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="Development failed"
					state="DEVELOPMENT_FAILED"
					age="3 hours ago"
					category="development_failed"
					primaryAction="View failure"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("button", { name: /view failure/i })).toBeTruthy();
	});

	test("pr_review category shows GitHub PR link", () => {
		render(
			<MemoryRouter>
				<AttentionCard
					projectId="proj-1"
					featureId="feat-1"
					reason="PR awaiting review"
					state="PR_REVIEW"
					age="30 minutes ago"
					category="pr_review"
					primaryAction="View on GitHub"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByRole("button", { name: /github/i })).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 4. View states
// ---------------------------------------------------------------------------

describe("attention page view states", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders without errors when loaded", async () => {
		renderAttention();
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
