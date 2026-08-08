/**
 * RED tests for project registration/validation, project overview, release
 * list/detail, feature planning, editing, and archival owner workflows
 * (requirement 26).
 *
 * Covers: validation check results, save gating, duplicate pending prevention,
 * safe errors, protected edit/archive confirmations, release development
 * progress wording, feature PLANNED creation, forms, narrow card layouts,
 * responsive behavior, and accessibility foundations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createApiClient } from "../../api/client";
import { AuthProvider } from "../../auth/auth-provider";

// ---------------------------------------------------------------------------
// Stub page components — these are the modules under test.
// ---------------------------------------------------------------------------

let ProjectsPage: React.ComponentType;
let ProjectForm: React.ComponentType<{
	onSubmit: (data: unknown) => void;
	onCancel: () => void;
	initialData?: Record<string, unknown>;
	isSubmitting?: boolean;
	serverError?: string | null;
	validationChecks?: Array<{ code: string; ok: boolean; message: string }>;
	validationAllPassed?: boolean;
	onValidate?: (data: unknown) => void;
	isValidating?: boolean;
}>;
let ProjectValidationResults: React.ComponentType<{
	checks: Array<{ code: string; ok: boolean; message: string }>;
	allPassed: boolean;
}>;
let ProjectDetailPage: React.ComponentType;
let ReleasesPage: React.ComponentType;
let ReleaseForm: React.ComponentType<{
	onSubmit: (data: unknown) => void;
	onCancel: () => void;
	initialData?: Record<string, unknown>;
	isSubmitting?: boolean;
	serverError?: string | null;
	projectId?: string;
}>;
let ReleaseDetailPage: React.ComponentType;
let FeatureForm: React.ComponentType<{
	onSubmit: (data: unknown) => void;
	onCancel: () => void;
	isSubmitting?: boolean;
	serverError?: string | null;
	projectId?: string;
	releaseId?: string;
}>;

try {
	ProjectsPage = (await import("./projects-page")).ProjectsPage;
} catch {
	ProjectsPage = () => <div data-testid="projects-missing" />;
}
try {
	ProjectForm = (await import("./project-form")).ProjectForm;
} catch {
	ProjectForm = () => <div data-testid="project-form-missing" />;
}
try {
	ProjectValidationResults = (await import("./project-validation-results"))
		.ProjectValidationResults;
} catch {
	ProjectValidationResults = () => <div data-testid="validation-results-missing" />;
}
try {
	ProjectDetailPage = (await import("./project-detail-page")).ProjectDetailPage;
} catch {
	ProjectDetailPage = () => <div data-testid="project-detail-missing" />;
}
try {
	ReleasesPage = (await import("../releases/releases-page")).ReleasesPage;
} catch {
	ReleasesPage = () => <div data-testid="releases-missing" />;
}
try {
	ReleaseForm = (await import("../releases/release-form")).ReleaseForm;
} catch {
	ReleaseForm = () => <div data-testid="release-form-missing" />;
}
try {
	ReleaseDetailPage = (await import("../releases/release-detail-page")).ReleaseDetailPage;
} catch {
	ReleaseDetailPage = () => <div data-testid="release-detail-missing" />;
}
try {
	FeatureForm = (await import("../features/feature-form")).FeatureForm;
} catch {
	FeatureForm = () => <div data-testid="feature-form-missing" />;
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

function routePatternFromPath(path: string): string {
	// Convert literal paths like /projects/p1 into patterns like /projects/:id
	// by replacing UUID-like or known ID segments with :id
	return path
		.replace(/\/projects\/[^/]+$/, "/projects/:id")
		.replace(/\/releases\/[^/]+$/, "/releases/:id")
		.replace(/\/features\/[^/]+$/, "/features/:id");
}

function renderWithRouter(initialEntries: string[], element: React.ReactNode) {
	const entryPath = initialEntries[0] ?? "/";
	const routePath = routePatternFromPath(entryPath);
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
			{
				path: "/login",
				element: <div>Login</div>,
			},
		],
		{ initialEntries },
	);
	return render(<RouterProvider router={router} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Project flows (requirement 26)", () => {
	beforeEach(() => {
		restoreFetch = installFetchMock();
		fetchOverride = null;
	});
	afterEach(() => {
		if (restoreFetch) restoreFetch();
		cleanup();
	});

	// =========================================================================
	// ProjectsPage — list
	// =========================================================================

	describe("ProjectsPage", () => {
		test("renders project list", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/projects")) {
					return jsonResponse({
						ok: true,
						data: [
							{
								id: "p1",
								name: "Alpha",
								slug: "alpha",
								status: "active",
								githubOwner: "org",
								githubRepo: "alpha",
								developmentBranch: "main",
							},
							{
								id: "p2",
								name: "Beta",
								slug: "beta",
								status: "active",
								githubOwner: "org",
								githubRepo: "beta",
								developmentBranch: "main",
							},
						],
					});
				}
				return jsonResponse({ ok: true, data: [] });
			};

			renderWithRouter(["/projects"], <ProjectsPage />);

			await waitFor(() => {
				expect(screen.getByText("Alpha")).toBeTruthy();
				expect(screen.getByText("Beta")).toBeTruthy();
			});
		});

		test("shows empty state when no projects exist", async () => {
			fetchOverride = async () => jsonResponse({ ok: true, data: [] });

			renderWithRouter(["/projects"], <ProjectsPage />);

			await waitFor(() => {
				const empty = screen.getByText(/no projects/i);
				expect(empty).toBeTruthy();
			});
		});

		test("shows loading state before data arrives", () => {
			fetchOverride = async () => new Promise(() => {});

			renderWithRouter(["/projects"], <ProjectsPage />);

			const loading = screen.getByRole("status");
			expect(loading).toBeTruthy();
		});

		test("shows error state on fetch failure", async () => {
			fetchOverride = async () => {
				throw new Error("network");
			};

			renderWithRouter(["/projects"], <ProjectsPage />);

			await waitFor(() => {
				expect(screen.getByRole("alert")).toBeTruthy();
			});
		});

		test("has an add project button linking to create form", async () => {
			fetchOverride = async () => jsonResponse({ ok: true, data: [] });

			renderWithRouter(["/projects"], <ProjectsPage />);

			await waitFor(() => {
				const btn =
					screen.getByRole("link", { name: /add project/i }) ||
					screen.getByRole("button", { name: /add project/i });
				expect(btn).toBeTruthy();
			});
		});

		test("renders projects as cards on narrow viewports", async () => {
			fetchOverride = async () =>
				jsonResponse({
					ok: true,
					data: [
						{
							id: "p1",
							name: "Alpha",
							slug: "alpha",
							status: "active",
							githubOwner: "org",
							githubRepo: "alpha",
							developmentBranch: "main",
						},
					],
				});

			Object.defineProperty(window, "innerWidth", { value: 375, writable: true });
			window.dispatchEvent(new Event("resize"));

			renderWithRouter(["/projects"], <ProjectsPage />);

			await waitFor(() => {
				expect(screen.getByText("Alpha")).toBeTruthy();
			});
		});
	});

	// =========================================================================
	// ProjectForm — create/edit
	// =========================================================================

	describe("ProjectForm", () => {
		test("renders form fields for name, slug, github owner, repo, path, branch, description", () => {
			renderWithRouter(["/projects/new"], <ProjectForm onSubmit={() => {}} onCancel={() => {}} />);

			expect(screen.getByLabelText(/name/i)).toBeTruthy();
			expect(screen.getByLabelText(/slug/i)).toBeTruthy();
			expect(
				screen.getByLabelText(/github owner/i) || screen.getByLabelText(/owner/i),
			).toBeTruthy();
			expect(screen.getByLabelText(/repository/i) || screen.getByLabelText(/repo/i)).toBeTruthy();
			expect(
				screen.getByLabelText(/workspace path/i) || screen.getByLabelText(/path/i),
			).toBeTruthy();
			expect(
				screen.getByLabelText(/development branch/i) || screen.getByLabelText(/branch/i),
			).toBeTruthy();
		});

		test("shows validation results when provided", () => {
			const checks = [
				{ code: "ROOT_CONTAINMENT", ok: true, message: "Path verified" },
				{ code: "GIT_REPOSITORY", ok: false, message: "Not a git repo" },
			];

			renderWithRouter(["/projects/new"], <ProjectForm onSubmit={() => {}} onCancel={() => {}} />);

			render(<ProjectValidationResults checks={checks} allPassed={false} />);

			expect(screen.getByText("Path verified")).toBeTruthy();
			expect(screen.getByText("Not a git repo")).toBeTruthy();
		});

		test("submit button is disabled when submitting", () => {
			renderWithRouter(
				["/projects/new"],
				<ProjectForm onSubmit={() => {}} onCancel={() => {}} isSubmitting validationAllPassed />,
			);

			const submit = screen.getByRole("button", { name: /create|save|submit/i });
			expect(
				submit.hasAttribute("disabled") || submit.getAttribute("aria-disabled") === "true",
			).toBeTrue();
		});

		test("save remains disabled until all required validations pass", () => {
			renderWithRouter(
				["/projects/new"],
				<ProjectForm
					onSubmit={() => {}}
					onCancel={() => {}}
					validationChecks={[
						{ code: "ROOT_CONTAINMENT", ok: true, message: "Path verified" },
						{ code: "GIT_REPOSITORY", ok: false, message: "Not a git repo" },
					]}
					validationAllPassed={false}
				/>,
			);

			const submit = screen.getByRole("button", { name: /create|save|submit/i });
			expect(
				submit.hasAttribute("disabled") || submit.getAttribute("aria-disabled") === "true",
			).toBeTrue();
			expect(screen.getByText("Path verified")).toBeTruthy();
			expect(screen.getByText("Not a git repo")).toBeTruthy();
		});

		test("save is enabled only after validationAllPassed", () => {
			renderWithRouter(
				["/projects/new"],
				<ProjectForm
					onSubmit={() => {}}
					onCancel={() => {}}
					validationChecks={[{ code: "ROOT_CONTAINMENT", ok: true, message: "Path verified" }]}
					validationAllPassed
				/>,
			);

			const submit = screen.getByRole("button", { name: /create|save|submit/i });
			expect(submit.hasAttribute("disabled")).toBeFalse();
		});

		test("validate action is available and disabled while validating", () => {
			renderWithRouter(
				["/projects/new"],
				<ProjectForm onSubmit={() => {}} onCancel={() => {}} onValidate={() => {}} isValidating />,
			);

			const validate = screen.getByRole("button", { name: /validate/i });
			expect(validate).toBeTruthy();
			expect(
				validate.hasAttribute("disabled") || validate.getAttribute("aria-disabled") === "true",
			).toBeTrue();
		});

		test("shows server error when provided", () => {
			renderWithRouter(
				["/projects/new"],
				<ProjectForm onSubmit={() => {}} onCancel={() => {}} serverError="Name already exists" />,
			);

			expect(screen.getByText(/name already exists/i)).toBeTruthy();
		});

		test("calls onSubmit with form data", async () => {
			let submitted = false;
			renderWithRouter(
				["/projects/new"],
				<ProjectForm
					onSubmit={() => {
						submitted = true;
					}}
					onCancel={() => {}}
					validationAllPassed
				/>,
			);

			const nameInput = screen.getByLabelText(/name/i);
			fireEvent.change(nameInput, { target: { value: "My Project" } });

			const form = nameInput.closest("form");
			if (form) {
				fireEvent.submit(form);
			} else {
				const submit = screen.getByRole("button", { name: /create|save|submit/i });
				fireEvent.click(submit);
			}

			await waitFor(() => {
				expect(submitted).toBeTrue();
			});
		});

		test("cancel calls onCancel callback", () => {
			let cancelled = false;
			renderWithRouter(
				["/projects/new"],
				<ProjectForm
					onSubmit={() => {}}
					onCancel={() => {
						cancelled = true;
					}}
				/>,
			);

			const cancel = screen.getByRole("button", { name: /cancel/i });
			fireEvent.click(cancel);
			expect(cancelled).toBeTrue();
		});
	});

	// =========================================================================
	// ProjectValidationResults — check display
	// =========================================================================

	describe("ProjectValidationResults", () => {
		test("renders all validation checks with pass/fail status", () => {
			const checks = [
				{ code: "ROOT_CONTAINMENT", ok: true, message: "Path is within allowlist" },
				{ code: "GIT_REPOSITORY", ok: true, message: "Valid git repository" },
				{ code: "REMOTE_IDENTITY", ok: false, message: "Remote does not match" },
				{ code: "GH_AUTHENTICATION", ok: true, message: "Authenticated" },
			];

			render(<ProjectValidationResults checks={checks} allPassed={false} />);

			expect(screen.getByText("Path is within allowlist")).toBeTruthy();
			expect(screen.getByText("Valid git repository")).toBeTruthy();
			expect(screen.getByText("Remote does not match")).toBeTruthy();
			expect(screen.getByText("Authenticated")).toBeTruthy();
		});

		test("shows aggregate pass status", () => {
			const checks = [{ code: "ROOT_CONTAINMENT", ok: true, message: "OK" }];

			render(<ProjectValidationResults checks={checks} allPassed />);

			const status =
				screen.getByText(/all checks passed|ready to save/i) || screen.getByRole("status");
			expect(status).toBeTruthy();
		});

		test("does not expose credentials or raw command output", () => {
			const checks = [{ code: "REMOTE_IDENTITY", ok: true, message: "Remote verified" }];

			render(<ProjectValidationResults checks={checks} allPassed />);

			const text = document.body.textContent ?? "";
			expect(text).not.toContain("token");
			expect(text).not.toContain("password");
			expect(text).not.toContain("ghp_");
		});
	});

	// =========================================================================
	// ProjectDetailPage — detail view
	// =========================================================================

	describe("ProjectDetailPage", () => {
		test("unwraps the canonical project detail envelope", async () => {
			fetchOverride = async () =>
				jsonResponse({
					ok: true,
					data: {
						id: "p1",
						name: "Envelope Project",
						slug: "envelope-project",
						githubOwner: "org",
						githubRepo: "repo",
						developmentBranch: "main",
						status: "active",
						releases: [],
					},
				});

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);
			await waitFor(() => expect(screen.getByText("Envelope Project")).toBeTruthy());
		});

		test("archives through the authenticated client and surfaces API errors", async () => {
			let archiveInit: RequestInit | undefined;
			fetchOverride = async (url, init) => {
				if (url.endsWith("/archive")) {
					archiveInit = init;
					return jsonResponse(
						{
							ok: false,
							error: { code: "CONFLICT", message: "Active job blocks archive", httpStatus: 409 },
						},
						409,
					);
				}
				return jsonResponse({
					ok: true,
					data: {
						id: "p1",
						name: "Alpha",
						slug: "alpha",
						githubOwner: "org",
						githubRepo: "alpha",
						developmentBranch: "main",
						status: "active",
						releases: [],
					},
				});
			};

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);
			fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
			fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }));
			await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Active job"));
			expect((archiveInit?.headers as Record<string, string> | undefined)?.["x-csrf-token"]).toBe(
				"test-csrf",
			);
		});
		test("renders project detail with name, repository, branch", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/projects/p1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "p1",
							name: "Alpha",
							slug: "alpha",
							githubOwner: "org",
							githubRepo: "alpha",
							developmentBranch: "main",
							status: "active",
							releases: [],
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);

			await waitFor(() => {
				expect(screen.getByText("Alpha")).toBeTruthy();
				expect(screen.getByText(/org\/alpha/) || screen.getByText(/github/)).toBeTruthy();
				expect(screen.getByText(/main/)).toBeTruthy();
			});
		});

		test("lists releases with development progress", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/projects/p1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "p1",
							name: "Alpha",
							slug: "alpha",
							githubOwner: "org",
							githubRepo: "alpha",
							developmentBranch: "main",
							status: "active",
							releases: [
								{
									id: "r1",
									name: "v1.0",
									version: "1.0.0",
									status: "In Development",
									archivedAt: null,
								},
							],
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);

			await waitFor(() => {
				expect(screen.getByText(/v1\.0/) || screen.getByText("1.0.0")).toBeTruthy();
				expect(screen.getByText(/In Development/) || screen.getByText(/development/i)).toBeTruthy();
			});
		});

		test("shows edit and archive actions for active project", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/projects/p1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "p1",
							name: "Alpha",
							slug: "alpha",
							githubOwner: "org",
							githubRepo: "alpha",
							developmentBranch: "main",
							status: "active",
							releases: [],
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);

			await waitFor(() => {
				const editBtn = screen.queryByRole("link", { name: /edit/i });
				expect(editBtn).toBeTruthy();

				const archiveBtn = screen.getByRole("button", { name: /archive/i });
				expect(archiveBtn).toBeTruthy();
			});
		});

		test("archive confirmation names the exact project", async () => {
			fetchOverride = async (url) => {
				if (typeof url === "string" && url.includes("/api/projects/p1")) {
					return jsonResponse({
						ok: true,
						data: {
							id: "p1",
							name: "Alpha",
							slug: "alpha",
							githubOwner: "org",
							githubRepo: "alpha",
							developmentBranch: "main",
							status: "active",
							releases: [],
						},
					});
				}
				return jsonResponse({ ok: true });
			};

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);

			await waitFor(() => {
				const archiveBtn = screen.getByRole("button", { name: /archive/i });
				fireEvent.click(archiveBtn);
			});

			await waitFor(() => {
				const text = document.body.textContent ?? "";
				expect(text).toContain("Alpha");
				expect(text).toMatch(/confirm|are you sure/i);
			});
		});

		test("shows loading state", () => {
			fetchOverride = async () => new Promise(() => {});

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);

			expect(screen.getByRole("status")).toBeTruthy();
		});

		test("shows error state on not found", async () => {
			fetchOverride = async () => jsonResponse({ error: "Not found" }, 404);

			renderWithRouter(["/projects/p1"], <ProjectDetailPage />);

			await waitFor(() => {
				expect(screen.getByRole("alert")).toBeTruthy();
			});
		});
	});

	// =========================================================================
	// ReleasesPage — list
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
	});

	// =========================================================================
	// ReleaseForm — create/edit
	// =========================================================================

	describe("ReleaseForm", () => {
		test("renders fields for name, version, description", () => {
			renderWithRouter(
				["/releases/new"],
				<ReleaseForm onSubmit={() => {}} onCancel={() => {}} projectId="p1" />,
			);

			expect(screen.getByLabelText(/name/i)).toBeTruthy();
			expect(screen.getByLabelText(/version/i)).toBeTruthy();
		});

		test("calls onSubmit with form data", async () => {
			let submitted = false;
			renderWithRouter(
				["/releases/new"],
				<ReleaseForm
					onSubmit={() => {
						submitted = true;
					}}
					onCancel={() => {}}
					projectId="p1"
				/>,
			);

			const nameInput = screen.getByLabelText(/name/i);
			fireEvent.change(nameInput, { target: { value: "v1.0" } });

			const versionInput = screen.getByLabelText(/version/i);
			fireEvent.change(versionInput, { target: { value: "1.0.0" } });

			const form = nameInput.closest("form");
			if (form) {
				fireEvent.submit(form);
			} else {
				const submit = screen.getByRole("button", { name: /create|save|submit/i });
				fireEvent.click(submit);
			}

			await waitFor(() => {
				expect(submitted).toBeTrue();
			});
		});

		test("shows error on uniqueness violation", () => {
			renderWithRouter(
				["/releases/new"],
				<ReleaseForm
					onSubmit={() => {}}
					onCancel={() => {}}
					serverError="Release name already exists"
					projectId="p1"
				/>,
			);

			expect(screen.getByText(/already exists/i)).toBeTruthy();
		});
	});

	// =========================================================================
	// ReleaseDetailPage — detail with features
	// =========================================================================

	describe("ReleaseDetailPage", () => {
		test("unwraps the canonical release detail envelope", async () => {
			fetchOverride = async () =>
				jsonResponse({
					ok: true,
					data: {
						id: "r1",
						projectId: "p1",
						name: "Envelope Release",
						version: "1.0.0",
						status: "active",
						features: [],
						developmentProgress: { total: 0, merged: 0 },
					},
				});

			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);
			await waitFor(() => expect(screen.getByText("Envelope Release")).toBeTruthy());
		});
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

		test("shows development progress not production-ready language", async () => {
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

		test("shows loading and error states", async () => {
			fetchOverride = async () => new Promise(() => {});
			renderWithRouter(["/releases/r1"], <ReleaseDetailPage />);
			expect(screen.getByRole("status")).toBeTruthy();
		});
	});

	// =========================================================================
	// FeatureForm — create feature
	// =========================================================================

	describe("FeatureForm", () => {
		test("renders fields for title, slug, summary", () => {
			renderWithRouter(
				["/features/new"],
				<FeatureForm onSubmit={() => {}} onCancel={() => {}} projectId="p1" releaseId="r1" />,
			);

			expect(screen.getByLabelText(/title/i)).toBeTruthy();
			expect(screen.getByLabelText(/slug/i)).toBeTruthy();
		});

		test("shows PLANNED state context for new features", () => {
			renderWithRouter(
				["/features/new"],
				<FeatureForm onSubmit={() => {}} onCancel={() => {}} projectId="p1" releaseId="r1" />,
			);

			const text = document.body.textContent ?? "";
			expect(text).toMatch(/planned/i);
		});

		test("shows branch context when slug is entered", async () => {
			renderWithRouter(
				["/features/new"],
				<FeatureForm onSubmit={() => {}} onCancel={() => {}} projectId="p1" releaseId="r1" />,
			);

			const slugInput = screen.getByLabelText(/slug/i);
			fireEvent.change(slugInput, { target: { value: "my-feature" } });

			await waitFor(() => {
				const text = document.body.textContent ?? "";
				expect(text).toMatch(/feature\//i);
				expect(text).toMatch(/my-feature/i);
			});
		});

		test("calls onSubmit with form data", async () => {
			let submitted = false;
			renderWithRouter(
				["/features/new"],
				<FeatureForm
					onSubmit={() => {
						submitted = true;
					}}
					onCancel={() => {}}
					projectId="p1"
					releaseId="r1"
				/>,
			);

			const titleInput = screen.getByLabelText(/title/i);
			fireEvent.change(titleInput, { target: { value: "My Feature" } });

			const slugInput = screen.getByLabelText(/slug/i);
			fireEvent.change(slugInput, { target: { value: "my-feature" } });

			const form = titleInput.closest("form");
			if (form) {
				fireEvent.submit(form);
			} else {
				const submit = screen.getByRole("button", { name: /create|save|submit/i });
				fireEvent.click(submit);
			}

			await waitFor(() => {
				expect(submitted).toBeTrue();
			});
		});

		test("shows server error on uniqueness violation", () => {
			renderWithRouter(
				["/features/new"],
				<FeatureForm
					onSubmit={() => {}}
					onCancel={() => {}}
					serverError="Feature slug already exists"
					projectId="p1"
					releaseId="r1"
				/>,
			);

			expect(screen.getByText(/already exists/i)).toBeTruthy();
		});

		test("submit is disabled while submitting", () => {
			renderWithRouter(
				["/features/new"],
				<FeatureForm
					onSubmit={() => {}}
					onCancel={() => {}}
					isSubmitting
					projectId="p1"
					releaseId="r1"
				/>,
			);

			const submit = screen.getByRole("button", { name: /create|save|submit/i });
			expect(
				submit.hasAttribute("disabled") || submit.getAttribute("aria-disabled") === "true",
			).toBeTrue();
		});
	});

	// =========================================================================
	// ValidationResults — credentials safety
	// =========================================================================

	describe("ValidationResults credential safety", () => {
		test("validation check messages never contain tokens or passwords", () => {
			const checks = [
				{ code: "GH_AUTHENTICATION", ok: true, message: "GitHub authenticated" },
				{ code: "PUSH_FEASIBILITY", ok: true, message: "Push access confirmed" },
			];

			render(<ProjectValidationResults checks={checks} allPassed />);

			const allText = document.body.textContent ?? "";
			const lower = allText.toLowerCase();
			expect(lower).not.toContain("ghp_");
			expect(lower).not.toContain("gho_");
			expect(lower).not.toContain("password");
			expect(lower).not.toContain("authorization");
			expect(lower).not.toContain("bearer");
		});
	});

	// =========================================================================
	// Accessibility foundations
	// =========================================================================

	describe("Accessibility", () => {
		test("forms have associated labels", () => {
			renderWithRouter(["/projects/new"], <ProjectForm onSubmit={() => {}} onCancel={() => {}} />);

			const nameInput = screen.getByLabelText(/name/i);
			expect(nameInput.getAttribute("id") || nameInput.getAttribute("name")).toBeTruthy();
		});

		test("error states use alert role", async () => {
			fetchOverride = async () => {
				throw new Error("fail");
			};

			renderWithRouter(["/projects"], <ProjectsPage />);

			await waitFor(() => {
				expect(screen.getByRole("alert")).toBeTruthy();
			});
		});

		test("loading states use status role", () => {
			fetchOverride = async () => new Promise(() => {});
			renderWithRouter(["/projects"], <ProjectsPage />);
			expect(screen.getByRole("status")).toBeTruthy();
		});
	});
});
