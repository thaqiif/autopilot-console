import { Link } from "react-router-dom";

const NAV_ITEMS = [
	{ label: "Overview", path: "/" },
	{ label: "Attention", path: "/attention" },
	{ label: "Releases", path: "/releases" },
	{ label: "Projects", path: "/projects" },
	{ label: "Activity", path: "/activity" },
	{ label: "Settings", path: "/settings" },
] as const;

export interface DesktopNavigationProps {
	currentPath: string;
}

function isActivePath(currentPath: string, itemPath: string): boolean {
	return itemPath === "/"
		? currentPath === "/"
		: currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

export function DesktopNavigation({ currentPath }: DesktopNavigationProps) {
	return (
		<nav aria-label="Main navigation" className="desktop-navigation">
			<ul>
				{NAV_ITEMS.map((item) => (
					<li key={item.path}>
						<Link
							to={item.path}
							aria-current={isActivePath(currentPath, item.path) ? "page" : undefined}
						>
							{item.label}
						</Link>
					</li>
				))}
			</ul>
		</nav>
	);
}
