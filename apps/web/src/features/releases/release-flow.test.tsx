/**
 * RED-to-GREEN tests for release listing/detail, archive, feature links, and
 * development progress wording (requirement 26 acceptance criteria).
 *
 * Covers: release archive with confirmation, feature links, empty state,
 * development-only wording, loading/error states, and API error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createApiClient } from "../../api/client";
import { AuthProvider } from "../../auth/auth-provider";

// ---------------------------------------------------------------------------
// Dynamic imports — modules under test
// ---------------------------------------------------------------------------

let ReleaseDetailPage: React.ComponentType;
let ReleasesPage: React.ComponentType;

try {
	ReleaseDetailPage = (await import("./release-detail-page")).ReleaseDetailPage;
} catch {
	ReleaseDetailPage = () => <div data-testid="release-detail-missing" />;
}
try {
	ReleasesPage = (await import("./releases-page")).ReleasesPage;
} catch {
	ReleasesPage = () => <div data-testid="releases-missing" />;
}

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

let fetchOverride: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

function installFetchMock() {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (fetchOverride) return fetchOverride(url, init);
		return new Response(null, { status: 404 });
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
		fetchOverride = null;
	};
}

let restoreFetch: (() => void) | null = null;

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// Router helper
// ---------------------------------------------------------------------------

function renderWithRouter(initialEntries: string[], element: React.ReactNode) {
	const entryPath = initialEntries[0] ?? "/";
	const routePath = entryPath
		.replace(/\/projects\/[^/]+$/, "/projects/:id")
		.replace(/\/releases\/[^/]+$/, "/releases/:id")
		.replace(/\/features\/[^/]+$/, "/features/:id");
	const client = createApiClient({ baseUrl: "", getCsrfToken: () => "test-csrf" });
	const router = createMemoryRouter(
		[
			{
				path: routePath,
				element: (
					<AuthProvider client={client} initialAuthenticated>
						{element}
					</AuthProvider>
				),
			},
			{ path: "/login", element: <div>Login</div> },
		],
		{ initialEntries },
	);
	return render(<RouterProvider router={router} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Release flows (requirement 26)", () => {
	beforeEach(() => {
		restoreFetch = installFetchMock();
		fetchOverride = null;
	});
	afterEach(() => {
		if (restoreFetch) restoreFetch();
		cleanup();
	});

	// =========================================================================
	// ReleasesPage — listing
	// =========================================================================

	describe("ReleasesPage", () => {
		test("renders release list with project context and development progress", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases")) {
					return jsonResponse({
						ok: true,
						data: [
							{
								id: "r1",
								projectId: "p1",
								projectName: "Alpha",
								name: "v1.0",
								version: "1.0.0",
								status: "In Development",
								developmentProgress: { total: 5, merged: 2 },
							},
						],
					});
				}
				return jsonResponse({ ok: true, data: [] });
			};

			renderWithRouter(["/releases"], <ReleasesPage />);

			await waitFor(() => {
				expect(screen.getByText(/v1\.0/) || screen.getByText("1.0.0")).toBeTruthy();
				expect(screen.getByText(/Alpha/)).toBeTruthy();
				const devTexts = screen.getAllByText(/development/i);
				expect(devTexts.length).toBeGreaterThanOrEqual(1);
			});
		});

		test("shows empty state when no releases", async () => {
			fetchOverride = async () => jsonResponse({ ok: true, data: [] });

			renderWithRouter(["/releases"], <ReleasesPage />);

			await waitFor(() => {
				expect(screen.getByText(/no releases/i)).toBeTruthy();
			});
		});

		test("does not use production-ready language for development status", async () => {
			fetchOverride = async () =>
				jsonResponse({
					ok: true,
					data: [
						{
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "Development Merged",
							developmentProgress: { total: 3, merged: 3 },
						},
					],
				});

			renderWithRouter(["/releases"], <ReleasesPage />);

			await waitFor(() => {
				const text = document.body.textContent ?? "";
				expect(text).not.toMatch(/production.ready|released|deployed/i);
				expect(text).toMatch(/development/i);
			});
		});

		test("shows loading state", () => {
			fetchOverride = async () => new Promise(() => {});
			renderWithRouter(["/releases"], <ReleasesPage />);
			expect(screen.getByRole("status")).toBeTruthy();
		});

		test("shows error state on fetch failure", async () => {
			fetchOverride = async () => {
				throw new Error("fail");
			};
			renderWithRouter(["/releases"], <ReleasesPage />);
			await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		});
	});

	// =========================================================================
	// ReleaseDetailPage — detail, features, archive
	// =========================================================================

	describe("ReleaseDetailPage", () => {
		test("renders release detail with features list", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "In Development",
							features: [
								{
									id: "f1",
									title: "Auth",
									slug: "auth",
									state: "PLANNED",
									branchName: "feature/f1-auth",
								},
								{
									id: "f2",
									title: "Dashboard",
									slug: "dashboard",
									state: "DEVELOPMENT_MERGED",
									branchName: "feature/f2-dashboard",
								},
							],
							developmentProgress: { total: 2, merged: 1 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => {
				expect(screen.getByText(/v1\.0/) || screen.getByText("1.0.0")).toBeTruthy();
				expect(screen.getByText("Auth")).toBeTruthy();
				expect(screen.getByText("Dashboard")).toBeTruthy();
			});
		});

		test("features link to their detail pages", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "In Development",
							features: [
								{
									id: "f1",
									title: "Auth",
									slug: "auth",
									state: "PLANNED",
									branchName: "feature/f1-auth",
								},
							],
							developmentProgress: { total: 1, merged: 0 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => {
				const link = screen.getByRole("link", { name: /auth/i });
				expect(link.getAttribute("href")).toBe("/features/f1");
			});
		});

		test("shows empty features state", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "In Development",
							features: [],
							developmentProgress: { total: 0, merged: 0 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => {
				expect(screen.getByText(/no features/i)).toBeTruthy();
			});
		});

		test("shows development progress only, not production-ready language", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "In Development",
							features: [],
							developmentProgress: { total: 0, merged: 0 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => {
				const text = document.body.textContent ?? "";
				expect(text).toMatch(/development/i);
				expect(text).not.toMatch(/production.ready|released|deployed/i);
			});
		});

		test("shows loading state", () => {
			fetchOverride = async () => new Promise(() => {});
			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);
			expect(screen.getByRole("status")).toBeTruthy();
		});

		test("shows error state on not found", async () => {
			fetchOverride = async () => jsonResponse({ error: "Not found" }, 404);
			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);
			await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		});

		// -------- Archive --------

		test("has archive action for active release", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "active",
							features: [],
							developmentProgress: { total: 0, merged: 0 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => {
				expect(screen.getByRole("button", { name: /archive/i })).toBeTruthy();
			});
		});

		test("archive confirmation names the exact release", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "My Release",
							version: "1.0.0",
							status: "active",
							features: [],
							developmentProgress: { total: 0, merged: 0 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => fireEvent.click(screen.getByRole("button", { name: /archive/i })));
			await waitFor(() => {
				const text = document.body.textContent ?? "";
				expect(text).toContain("My Release");
				expect(text).toMatch(/confirm|are you sure/i);
			});
		});

		test("archive calls API and surfaces errors", async () => {
			fetchOverride = async (url) => {
				if (url.endsWith("/archive")) {
					return jsonResponse(
						{ ok: false, error: { code: "CONFLICT", message: "Active jobs prevent archival" } },
						409,
					);
				}
				return jsonResponse({
					ok: true,
					data: {
						id: "r1",
						projectId: "p1",
						name: "v1.0",
						version: "1.0.0",
						status: "active",
						features: [],
						developmentProgress: { total: 0, merged: 0 },
					},
				});
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => fireEvent.click(screen.getByRole("button", { name: /archive/i })));
			await waitFor(() =>
				fireEvent.click(screen.getByRole("button", { name: /confirm archive/i })),
			);
			await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		});

		test("no archive action for already-archived release", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/releases/r1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "r1",
							projectId: "p1",
							name: "v1.0",
							version: "1.0.0",
							status: "archived",
							features: [],
							developmentProgress: { total: 0, merged: 0 },
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);

			await waitFor(() => {
				const buttons = screen.queryAllByRole("button", { name: /archive/i });
				expect(buttons.length).toBe(0);
			});
		});
	});
});
