import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { createApiClient } from "../api/client";
import { AppShell } from "../app/app-shell";
import { AuthProvider, useAuth } from "./auth-provider";
import { LoginPage } from "./login-page";

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("browser authentication lifecycle", () => {
	beforeEach(cleanup);

	test("restores an existing session and retains the server-issued CSRF token", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const client = createApiClient({
			baseUrl: "",
			fetchOverride: async (url, init) => {
				requests.push({ url: String(url), init });
				return json({
					ok: true,
					data: { authenticated: true, username: "owner", csrfToken: "restored-csrf" },
				});
			},
		});
		function Probe() {
			const auth = useAuth();
			return (
				<div>{auth.loading ? "loading" : auth.authenticated ? "authenticated" : "signed-out"}</div>
			);
		}

		render(
			<AuthProvider client={client}>
				<Probe />
			</AuthProvider>,
		);

		await screen.findByText("authenticated");
		expect(requests[0]?.url).toBe("/api/auth/session");
		expect(
			(client.buildRequestInit("POST").headers as Record<string, string>)["x-csrf-token"],
		).toBe("restored-csrf");
	});

	test("login calls the API and navigates back to the protected destination", async () => {
		const requests: Array<{ url: string; body?: string }> = [];
		const client = createApiClient({
			baseUrl: "",
			fetchOverride: async (url, init) => {
				requests.push({ url: String(url), body: init?.body as string | undefined });
				return json({ ok: true, data: { authenticated: true, csrfToken: "login-csrf" } });
			},
		});
		const router = createMemoryRouter(
			[
				{
					element: (
						<AuthProvider client={client} initialAuthenticated={false}>
							<Outlet />
						</AuthProvider>
					),
					children: [
						{ path: "/login", element: <LoginPage /> },
						{
							path: "/projects",
							element: <AppShell />,
							children: [{ index: true, element: <div>Projects destination</div> }],
						},
					],
				},
			],
			{ initialEntries: [{ pathname: "/login", state: { from: "/projects" } }] },
		);
		render(<RouterProvider router={router} />);

		fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

		await screen.findByText("Projects destination");
		expect(requests[0]).toEqual({
			url: "/api/auth/login",
			body: JSON.stringify({ username: "owner", password: "secret" }),
		});
	});

	test("logout calls the protected endpoint then clears browser auth state", async () => {
		const paths: string[] = [];
		const client = createApiClient({
			baseUrl: "",
			fetchOverride: async (url) => {
				paths.push(String(url));
				return json({ ok: true, data: { loggedOut: true } });
			},
		});
		client.setCsrfToken("current-csrf");
		function Probe() {
			const auth = useAuth();
			return (
				<button type="button" onClick={() => void auth.logout()}>
					{auth.authenticated ? "Sign out" : "Signed out"}
				</button>
			);
		}
		render(
			<AuthProvider client={client} initialAuthenticated>
				<Probe />
			</AuthProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Signed out"));
		expect(paths).toEqual(["/api/auth/logout"]);
		expect(
			(client.buildRequestInit("POST").headers as Record<string, string>)["x-csrf-token"],
		).toBeUndefined();
	});
});
