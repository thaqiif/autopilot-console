import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { createApiClient } from "../api/client";
import { AuthProvider } from "../auth/auth-provider";
import { FeatureFormPage, ProjectFormPage, ReleaseFormPage } from "./form-pages";

afterEach(cleanup);

function response(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function renderPage(
	path: string,
	element: React.ReactNode,
	fetchOverride: (url: string, init?: RequestInit) => Promise<Response>,
) {
	const client = createApiClient({
		baseUrl: "",
		fetchOverride: (input, init) => fetchOverride(String(input), init),
	});
	client.setCsrfToken("csrf");
	const router = createMemoryRouter(
		[
			{
				element: (
					<AuthProvider client={client} initialAuthenticated>
						<Outlet />
					</AuthProvider>
				),
				children: [
					{ path: "/projects/new", element },
					{ path: "/releases/new", element },
					{ path: "/features/new", element },
					{ path: "/projects/:id", element: <div>Project destination</div> },
					{ path: "/releases/:id", element: <div>Release destination</div> },
					{ path: "/features/:id", element: <div>Feature destination</div> },
				],
			},
		],
		{ initialEntries: [path] },
	);
	return render(<RouterProvider router={router} />);
}

describe("functional form routes", () => {
	test("keeps project save disabled until validate succeeds, then creates the project", async () => {
		const requests: Array<{ url: string; body?: string }> = [];
		renderPage("/projects/new", <ProjectFormPage />, async (url, init) => {
			requests.push({ url, body: init?.body as string | undefined });
			if (url.includes("/api/projects/validate")) {
				return response({
					ok: true,
					data: {
						ok: true,
						canonicalPath: "/projects/alpha",
						checks: [
							{ code: "ROOT_CONTAINMENT", ok: true, message: "Path is within allowlist" },
							{ code: "GIT_REPOSITORY", ok: true, message: "Valid git repository" },
							{ code: "REMOTE_IDENTITY", ok: true, message: "Remote verified" },
							{ code: "DEVELOPMENT_BRANCH", ok: true, message: "Branch exists" },
							{ code: "AUTOPILOT_RUNTIME", ok: true, message: "Autopilot available" },
							{ code: "GH_AUTHENTICATION", ok: true, message: "Authenticated" },
							{ code: "REPOSITORY_ACCESS", ok: true, message: "Repository accessible" },
							{ code: "PUSH_FEASIBILITY", ok: true, message: "Push access confirmed" },
						],
					},
				});
			}
			return response({ ok: true, data: { id: "p1" } });
		});

		for (const [label, value] of [
			["Name", "Alpha"],
			["Slug", "alpha"],
			["GitHub owner", "org"],
			["Repository", "repo"],
			["Workspace path", "/projects/alpha"],
			["Development branch", "main"],
		] as const) {
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
		}

		const createBeforeValidate = screen.getByRole("button", { name: "Create project" });
		expect(createBeforeValidate.hasAttribute("disabled")).toBeTrue();

		fireEvent.click(screen.getByRole("button", { name: /validate/i }));
		await screen.findByText(/all checks passed|ready to save/i);
		expect(screen.getByText("Path is within allowlist")).toBeTruthy();

		const create = screen.getByRole("button", { name: "Create project" });
		expect(create.hasAttribute("disabled")).toBeFalse();
		fireEvent.click(create);

		await screen.findByText("Project destination");
		expect(requests.some((r) => r.url === "/api/projects/validate")).toBeTrue();
		const createRequest = requests.find((r) => r.url === "/api/projects");
		expect(createRequest).toBeTruthy();
		expect(JSON.parse(createRequest?.body ?? "{}")).toMatchObject({
			name: "Alpha",
			slug: "alpha",
			githubOwner: "org",
			githubRepo: "repo",
			workspacePath: "/projects/alpha",
			developmentBranch: "main",
		});
		expect(JSON.parse(createRequest?.body ?? "{}").operationKey).toBeTruthy();
	});

	test("surfaces per-check validation failures without enabling save", async () => {
		renderPage("/projects/new", <ProjectFormPage />, async (url) => {
			if (url.includes("/api/projects/validate")) {
				return response({
					ok: true,
					data: {
						ok: false,
						canonicalPath: null,
						checks: [
							{ code: "ROOT_CONTAINMENT", ok: true, message: "Path verified" },
							{ code: "GIT_REPOSITORY", ok: false, message: "Not a git repo" },
						],
					},
				});
			}
			return response({ ok: true, data: { id: "p1" } });
		});

		for (const [label, value] of [
			["Name", "Alpha"],
			["Slug", "alpha"],
			["GitHub owner", "org"],
			["Repository", "repo"],
			["Workspace path", "/tmp/bad"],
			["Development branch", "main"],
		] as const) {
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
		}

		fireEvent.click(screen.getByRole("button", { name: /validate/i }));
		await screen.findByText("Not a git repo");
		expect(
			screen.getByRole("button", { name: "Create project" }).hasAttribute("disabled"),
		).toBeTrue();
		expect(document.body.textContent ?? "").not.toMatch(/ghp_|password|bearer/i);
	});

	test("creates a release with project context from the query string", async () => {
		let body: unknown;
		renderPage("/releases/new?projectId=p1", <ReleaseFormPage />, async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return response({ ok: true, data: { id: "r1" } });
		});
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Version 1" } });
		fireEvent.change(screen.getByLabelText("Version"), { target: { value: "1.0.0" } });
		fireEvent.click(screen.getByRole("button", { name: "Create release" }));

		await screen.findByText("Release destination");
		expect(body).toMatchObject({
			projectId: "p1",
			name: "Version 1",
			version: "1.0.0",
			description: "",
		});
		expect((body as { operationKey?: string }).operationKey).toBeTruthy();
	});

	test("creates a feature with project and release context", async () => {
		let body: unknown;
		renderPage(
			"/features/new?projectId=p1&releaseId=r1",
			<FeatureFormPage />,
			async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return response({ ok: true, data: { id: "f1" } });
			},
		);
		fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Authentication" } });
		fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "auth" } });
		expect(document.body.textContent ?? "").toMatch(/planned/i);
		fireEvent.click(screen.getByRole("button", { name: "Create feature" }));

		await waitFor(() => expect(screen.getByText("Feature destination")).toBeTruthy());
		expect(body).toMatchObject({
			projectId: "p1",
			releaseId: "r1",
			title: "Authentication",
			slug: "auth",
			summary: "",
		});
		expect((body as { operationKey?: string }).operationKey).toBeTruthy();
	});
});
