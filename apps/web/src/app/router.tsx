import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { AuthProvider } from "../auth/auth-provider";
import { LoginPage } from "../auth/login-page";
import { ActivityPage } from "../features/activity/activity-page";
import { AttentionPage } from "../features/attention/attention-page";
import { OverviewPage } from "../features/overview/overview-page";
import { SettingsPage } from "../features/settings/settings-page";
import { AppShell } from "./app-shell";

/**
 * Authenticated shell router (requirement 24).
 * Feature-planning / form destinations are added by later requirements.
 */
export function createRouter() {
	return createBrowserRouter([
		{
			element: (
				<AuthProvider>
					<Outlet />
				</AuthProvider>
			),
			children: [
				{ path: "/login", element: <LoginPage /> },
				{
					path: "/",
					element: <AppShell />,
					children: [
						{ index: true, element: <OverviewPage /> },
						{ path: "attention", element: <AttentionPage /> },
						{ path: "releases", element: <div>Releases</div> },
						{ path: "projects", element: <div>Projects</div> },
						{ path: "activity", element: <ActivityPage /> },
						{ path: "settings", element: <SettingsPage /> },
						{ path: "*", element: <Navigate to="/" replace /> },
					],
				},
			],
		},
	]);
}
