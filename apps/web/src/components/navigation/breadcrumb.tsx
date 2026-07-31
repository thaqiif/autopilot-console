import { Link, useLocation } from "react-router-dom";

function buildBreadcrumbs(pathname: string) {
	const segments = pathname.split("/").filter(Boolean);
	const crumbs = [{ label: "Home", path: "/" }];
	let current = "";
	for (const segment of segments) {
		current += `/${segment}`;
		crumbs.push({
			label: segment.charAt(0).toUpperCase() + segment.slice(1),
			path: current,
		});
	}
	return crumbs;
}

export function Breadcrumb() {
	const location = useLocation();
	const crumbs = buildBreadcrumbs(location.pathname);

	if (crumbs.length < 2) return null;

	return (
		<nav aria-label="Breadcrumb">
			<ol>
				{crumbs.map((crumb, i) => (
					<li key={crumb.path}>
						{i < crumbs.length - 1 ? (
							<Link to={crumb.path}>{crumb.label}</Link>
						) : (
							<span aria-current="page">{crumb.label}</span>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}

export function BackLink() {
	const location = useLocation();
	const segments = location.pathname.split("/").filter(Boolean);

	if (segments.length < 1) return null;

	const parentPath = `/${segments.slice(0, -1).join("/")}`;
	const parentLabel = segments.length > 1 ? segments[segments.length - 2] : "Home";

	return (
		<Link to={parentPath || "/"} aria-label={`Back to ${parentLabel}`}>
			Back
		</Link>
	);
}
