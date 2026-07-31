import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { AuthProvider } from "../auth/auth-provider";
import { LoginPage } from "../auth/login-page";
import { ActivityPage } from "../features/activity/activity-page";
import { AttentionPage } from "../features/attention/attention-page";
import { FeatureDetailPage } from "../features/features/feature-detail-page";
import { OverviewPage } from "../features/overview/overview-page";
import { ProjectDetailPage } from "../features/projects/project-detail-page";
import { ProjectsPage } from "../features/projects/projects-page";
import { ReleaseDetailPage } from "../features/releases/release-detail-page";
import { ReleasesPage } from "../features/releases/releases-page";
import { SettingsPage } from "../features/settings/settings-page";
import { AppShell } from "./app-shell";
import { FeatureFormPage, ProjectFormPage, ReleaseFormPage } from "./form-pages";

/**
 * Authenticated shell router with portfolio destinations and project/release/
 * feature planning workflows (requirements 24–26).
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
						{ path: "releases", element: <ReleasesPage /> },
						{ path: "releases/new", element: <ReleaseFormPage /> },
						{ path: "releases/:id", element: <ReleaseDetailPage /> },
						{ path: "releases/:id/edit", element: <ReleaseFormPage /> },
						{ path: "projects", element: <ProjectsPage /> },
						{ path: "projects/new", element: <ProjectFormPage /> },
						{ path: "projects/:id", element: <ProjectDetailPage /> },
						{ path: "projects/:id/edit", element: <ProjectFormPage /> },
						{ path: "features/new", element: <FeatureFormPage /> },
						{ path: "features/:id", element: <FeatureDetailPage /> },
						{ path: "features/:id/edit", element: <FeatureFormPage /> },
						{ path: "activity", element: <ActivityPage /> },
						{ path: "settings", element: <SettingsPage /> },
						{ path: "*", element: <Navigate to="/" replace /> },
					],
				},
			],
		},
	]);
}
