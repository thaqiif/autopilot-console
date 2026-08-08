import { Navigate, Outlet, useLocation } from "react-router-dom";
import { StatusAnnouncerProvider } from "../accessibility/status-announcer";
import { useAuth } from "../auth/auth-provider";
import { BackLink, Breadcrumb } from "../components/navigation/breadcrumb";
import { DesktopNavigation } from "../components/navigation/desktop-navigation";
import { MobileNavigation } from "../components/navigation/mobile-navigation";

export function AppShell() {
	const { authenticated, loading } = useAuth();
	const location = useLocation();
	const segments = location.pathname.split("/").filter(Boolean);
	const isNested = segments.length > 0;

	if (loading) {
		return <div role="status">Restoring session…</div>;
	}

	if (!authenticated) {
		return <Navigate to="/login" state={{ from: location.pathname }} replace />;
	}

	return (
		<StatusAnnouncerProvider>
			<a href="#main-content" className="skip-link">
				Skip to main content
			</a>
			<header>
				<DesktopNavigation currentPath={location.pathname} />
			</header>
			<main id="main-content" tabIndex={-1}>
				<h1 className="sr-only">Autopilot Console</h1>
				{isNested && <Breadcrumb />}
				{isNested && (
					<div className="mobile-back">
						<BackLink />
					</div>
				)}
				<Outlet />
			</main>
			<footer>
				<MobileNavigation currentPath={location.pathname} />
			</footer>
		</StatusAnnouncerProvider>
	);
}
