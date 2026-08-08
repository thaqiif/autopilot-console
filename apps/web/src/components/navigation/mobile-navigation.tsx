import { Link } from "react-router-dom";
import {
	isActivePath,
	mobilePrimaryDestinations,
	mobileSecondaryDestinations,
} from "../../app/route-meta";

export interface MobileNavigationProps {
	currentPath: string;
}

export function MobileNavigation({ currentPath }: MobileNavigationProps) {
	return (
		<>
			<nav aria-label="Mobile navigation" className="mobile-navigation">
				<ul>
					{mobilePrimaryDestinations().map((item) => (
						<li key={item.path}>
							<Link
								to={item.path}
								aria-current={isActivePath(currentPath, item.path) ? "page" : undefined}
							>
								{item.mobileLabel ?? item.label}
							</Link>
						</li>
					))}
				</ul>
			</nav>
			<nav aria-label="More destinations" className="mobile-secondary-navigation">
				{mobileSecondaryDestinations().map((item) => (
					<Link
						key={item.path}
						to={item.path}
						aria-current={isActivePath(currentPath, item.path) ? "page" : undefined}
					>
						{item.label}
					</Link>
				))}
			</nav>
		</>
	);
}
