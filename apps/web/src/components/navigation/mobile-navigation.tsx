import { Link } from "react-router-dom";

const MOBILE_NAV_ITEMS = [
	{ label: "Home", path: "/" },
	{ label: "Attention", path: "/attention" },
	{ label: "Releases", path: "/releases" },
	{ label: "Projects", path: "/projects" },
] as const;

export interface MobileNavigationProps {
	currentPath: string;
}

export function MobileNavigation({ currentPath }: MobileNavigationProps) {
	return (
		<>
			<nav aria-label="Mobile navigation" className="mobile-navigation">
				<ul>
					{MOBILE_NAV_ITEMS.map((item) => (
						<li key={item.path}>
							<Link to={item.path} aria-current={currentPath === item.path ? "page" : undefined}>
								{item.label}
							</Link>
						</li>
					))}
				</ul>
			</nav>
			<nav aria-label="More destinations" className="mobile-secondary-navigation">
				<Link
					to="/activity"
					aria-current={currentPath.startsWith("/activity") ? "page" : undefined}
				>
					Activity
				</Link>
				<Link
					to="/settings"
					aria-current={currentPath.startsWith("/settings") ? "page" : undefined}
				>
					Settings
				</Link>
			</nav>
		</>
	);
}
