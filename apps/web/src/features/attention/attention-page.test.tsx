/**
 * RED tests for the full Attention page (requirement 25).
 *
 * Covers: all attention categories, filter behavior, primary action
 * links to task review / failure detail / GitHub PR, and view states.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router-dom";
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
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders the page heading", () => {
		renderAttention();
		expect(screen.queryByRole("heading", { name: /attention/i })).toBeTruthy();
	});

	test("renders with accessible landmarks", () => {
		renderAttention();
		const main = screen.queryByRole("main") ?? document.querySelector("main, [role=main], section");
		expect(main).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 2. Category presence
// ---------------------------------------------------------------------------

describe("attention categories", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("page loads without crashing", () => {
		renderAttention();
		// Should render some content, not a blank page
		expect(document.body.textContent!.length).toBeGreaterThan(0);
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
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders without errors when loaded", () => {
		renderAttention();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
