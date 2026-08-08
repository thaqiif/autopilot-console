import { Link } from "react-router-dom";
import { desktopDestinations, isActivePath } from "../../app/route-meta";

export interface DesktopNavigationProps {
	currentPath: string;
}

export function DesktopNavigation({ currentPath }: DesktopNavigationProps) {
	return (
		<nav aria-label="Main navigation" className="desktop-navigation">
			<ul>
				{desktopDestinations().map((item) => (
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
