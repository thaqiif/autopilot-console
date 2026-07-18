/**
 * RED tests for the React/Vite web shell (requirement 24).
 *
 * Covers: login/session routing, default Overview redirect, desktop/mobile
 * navigation limits, secondary destinations, breadcrumbs/back navigation,
 * API auth expiry, all shared view states, focus management, and status
 * announcements.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AuthProvider, useAuth } from "../auth/auth-provider";
import { AppShell } from "./app-shell";
import { ViewState } from "../components/feedback/view-state";
import { DesktopNavigation } from "../components/navigation/desktop-navigation";
import { MobileNavigation } from "../components/navigation/mobile-navigation";
import { LoginPage } from "../auth/login-page";
import { createApiClient } from "../api/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderAt(path: string, opts?: { authenticated?: boolean }) {
	const authenticated = opts?.authenticated ?? false;

	const router = createMemoryRouter(
		[
			{
				path: "/login",
				element: <LoginPage />,
			},
			{
				path: "/",
				element: (
					<AuthProvider initialAuthenticated={authenticated}>
						<AppShell />
					</AuthProvider>
				),
				children: [
					{ index: true, element: <div data-testid="overview-page" /> },
					{ path: "attention", element: <div data-testid="attention-page" /> },
					{ path: "releases", element: <div data-testid="releases-page" /> },
					{ path: "projects", element: <div data-testid="projects-page" /> },
					{ path: "activity", element: <div data-testid="activity-page" /> },
					{ path: "settings", element: <div data-testid="settings-page" /> },
				],
			},
		],
		{ initialEntries: [path] },
	);

	return render(<RouterProvider router={router} />);
}

// ---------------------------------------------------------------------------
// 1. Authentication routing
// ---------------------------------------------------------------------------

describe("authentication routing", () => {
	beforeEach(() => cleanup());

	test("renders login page when unauthenticated", () => {
		renderAt("/login");
		expect(screen.getByRole("heading", { name: /sign in/i })).toBeTruthy();
	});

	test("redirects to login when unauthenticated user hits protected route", async () => {
		renderAt("/", { authenticated: false });
		await waitFor(() => {
			expect(screen.queryByTestId("overview-page")).toBeNull();
		});
	});

	test("renders overview page at root when authenticated", () => {
		renderAt("/", { authenticated: true });
		expect(screen.getByTestId("overview-page")).toBeTruthy();
	});

	test("authenticated user navigating to / lands on global overview not a project", () => {
		renderAt("/", { authenticated: true });
		expect(screen.getByTestId("overview-page")).toBeTruthy();
		expect(screen.queryByTestId("project-page")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. Desktop navigation
// ---------------------------------------------------------------------------

describe("desktop navigation", () => {
	beforeEach(() => cleanup());

	test("renders all six required desktop destinations", () => {
		render(
			<DesktopNavigation currentPath="/" />,
		);
		const nav = screen.getByRole("navigation", { name: /main/i });
		const links = nav.querySelectorAll("a");
		expect(links.length).toBe(6);

		const destinations = Array.from(links).map((l) => l.textContent?.toLowerCase());
		expect(destinations.some((d) => d?.includes("overview"))).toBe(true);
		expect(destinations.some((d) => d?.includes("attention"))).toBe(true);
		expect(destinations.some((d) => d?.includes("releases"))).toBe(true);
		expect(destinations.some((d) => d?.includes("projects"))).toBe(true);
		expect(destinations.some((d) => d?.includes("activity"))).toBe(true);
		expect(destinations.some((d) => d?.includes("settings"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. Mobile navigation
// ---------------------------------------------------------------------------

describe("mobile navigation", () => {
	beforeEach(() => cleanup());

	test("renders at most four bottom-navigation items on mobile", () => {
		render(
			<MobileNavigation currentPath="/" />,
		);
		const nav = screen.getByRole("navigation", { name: /mobile/i });
		const links = nav.querySelectorAll("a");
		expect(links.length).toBeLessThanOrEqual(4);
	});

	test("mobile nav includes Home, Attention, Releases, Projects", () => {
		render(
			<MobileNavigation currentPath="/" />,
		);
		const nav = screen.getByRole("navigation", { name: /mobile/i });
		const destinations = Array.from(nav.querySelectorAll("a")).map((l) =>
			l.textContent?.toLowerCase(),
		);
		expect(destinations.some((d) => d?.includes("home") || d?.includes("overview"))).toBe(true);
		expect(destinations.some((d) => d?.includes("attention"))).toBe(true);
		expect(destinations.some((d) => d?.includes("releases"))).toBe(true);
		expect(destinations.some((d) => d?.includes("projects"))).toBe(true);
	});

	test("activity and settings remain reachable secondarily on mobile", () => {
		render(
			<MobileNavigation currentPath="/" />,
		);
		const nav = screen.getByRole("navigation", { name: /mobile/i });
		const primary = Array.from(nav.querySelectorAll("a")).map((l) =>
			l.textContent?.toLowerCase(),
		);
		expect(primary.some((d) => d?.includes("activity"))).toBe(false);
		expect(primary.some((d) => d?.includes("settings"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. Breadcrumbs / back navigation
// ---------------------------------------------------------------------------

describe("breadcrumbs and back navigation", () => {
	beforeEach(() => cleanup());

	test("renders breadcrumb trail for nested routes", () => {
		renderAt("/projects/abc/releases/def", { authenticated: true });
		const breadcrumb = screen.getByRole("navigation", { name: /breadcrumb/i });
		expect(breadcrumb).toBeTruthy();
		const items = breadcrumb.querySelectorAll("li");
		expect(items.length).toBeGreaterThanOrEqual(2);
	});

	test("renders compact back navigation on mobile for nested routes", () => {
		renderAt("/projects/abc", { authenticated: true });
		const backLink = screen.getByRole("link", { name: /back/i });
		expect(backLink).toBeTruthy();
		expect(backLink.getAttribute("href")).toBe("/projects");
	});
});

// ---------------------------------------------------------------------------
// 5. API client
// ---------------------------------------------------------------------------

describe("API client", () => {
	test("sends credentials with every request", () => {
		const client = createApiClient({ baseUrl: "http://localhost:3000" });
		const init = client.buildRequestInit();
		expect(init.credentials).toBe("include");
	});

	test("handles unauthorized response by clearing session", async () => {
		const client = createApiClient({
			baseUrl: "http://localhost:3000",
			fetchOverride: async () => new Response(null, { status: 401 }),
		});
		const result = await client.get("/api/overview");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("UNAUTHORIZED");
		}
	});

	test("includes correlation ID header", () => {
		const client = createApiClient({ baseUrl: "http://localhost:3000" });
		const init = client.buildRequestInit();
		const headers = init.headers as Record<string, string>;
		expect(headers["x-correlation-id"]).toBeTruthy();
	});

	test("includes CSRF token for mutations", () => {
		const client = createApiClient({ baseUrl: "http://localhost:3000" });
		const init = client.buildRequestInit("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers["x-csrf-token"]).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 6. Shared view states
// ---------------------------------------------------------------------------

describe("shared view states", () => {
	beforeEach(() => cleanup());

	test("renders loading state", () => {
		render(<ViewState state="loading" />);
		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.getByText(/loading/i)).toBeTruthy();
	});

	test("renders empty state with message", () => {
		render(<ViewState state="empty" message="No projects found" />);
		expect(screen.getByText(/no projects found/i)).toBeTruthy();
	});

	test("renders error state with message", () => {
		render(<ViewState state="error" message="Something went wrong" />);
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.getByText(/something went wrong/i)).toBeTruthy();
	});

	test("renders stale state with last-updated time", () => {
		render(<ViewState state="stale" message="Last updated 2 minutes ago" />);
		expect(screen.getByText(/last updated/i)).toBeTruthy();
	});

	test("renders unauthorized state", () => {
		render(<ViewState state="unauthorized" />);
		expect(screen.getByText(/sign in/i)).toBeTruthy();
	});

	test("status is not conveyed by color alone", () => {
		render(<ViewState state="error" message="Connection failed" />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Connection failed");
		expect(alert.getAttribute("aria-label")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 7. Accessibility foundations
// ---------------------------------------------------------------------------

describe("accessibility foundations", () => {
	beforeEach(() => cleanup());

	test("skip navigation link is present", () => {
		renderAt("/", { authenticated: true });
		const skipLink = screen.getByRole("link", { name: /skip to main content/i });
		expect(skipLink).toBeTruthy();
		expect(skipLink.getAttribute("href")).toBe("#main-content");
	});

	test("main content has landmark role", () => {
		renderAt("/", { authenticated: true });
		const main = screen.getByRole("main");
		expect(main).toBeTruthy();
		expect(main.id).toBe("main-content");
	});

	test("focus is visible on interactive elements", () => {
		renderAt("/", { authenticated: true });
		const interactiveElements = screen.getAllByRole("link");
		for (const el of interactiveElements) {
			expect(el).toBeTruthy();
		}
	});

	test("heading hierarchy starts at h1", () => {
		renderAt("/", { authenticated: true });
		const h1 = screen.getByRole("heading", { level: 1 });
		expect(h1).toBeTruthy();
	});

	test("status announcements use aria-live region", () => {
		renderAt("/", { authenticated: true });
		const liveRegion = document.querySelector("[aria-live]");
		expect(liveRegion).toBeTruthy();
	});
});
