/**
 * Shared destination metadata for desktop/mobile navigation and breadcrumbs.
 * Keeps shell destinations in one place so later routes can extend without
 * duplicating labels/paths across navigation components.
 */

export interface NavDestination {
	/** Visible label for desktop navigation. */
	label: string;
	/** Router path. */
	path: string;
	/** Mobile bottom-nav label when different from desktop (e.g. Home). */
	mobileLabel?: string;
	/** Primary mobile bottom destinations (max four). */
	mobilePrimary?: boolean;
	/** Secondary mobile destinations (Activity, Settings). */
	mobileSecondary?: boolean;
}

export const PRIMARY_DESTINATIONS: readonly NavDestination[] = [
	{ label: "Overview", path: "/", mobileLabel: "Home", mobilePrimary: true },
	{ label: "Attention", path: "/attention", mobilePrimary: true },
	{ label: "Releases", path: "/releases", mobilePrimary: true },
	{ label: "Projects", path: "/projects", mobilePrimary: true },
	{ label: "Activity", path: "/activity", mobileSecondary: true },
	{ label: "Settings", path: "/settings", mobileSecondary: true },
] as const;

export function isActivePath(currentPath: string, itemPath: string): boolean {
	return itemPath === "/"
		? currentPath === "/"
		: currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

export function desktopDestinations(): readonly NavDestination[] {
	return PRIMARY_DESTINATIONS;
}

export function mobilePrimaryDestinations(): readonly NavDestination[] {
	return PRIMARY_DESTINATIONS.filter((d) => d.mobilePrimary);
}

export function mobileSecondaryDestinations(): readonly NavDestination[] {
	return PRIMARY_DESTINATIONS.filter((d) => d.mobileSecondary);
}

export function breadcrumbLabel(segment: string): string {
	const match = PRIMARY_DESTINATIONS.find(
		(d) => d.path === `/${segment}` || d.path.slice(1) === segment,
	);
	if (match) return match.label;
	return segment.charAt(0).toUpperCase() + segment.slice(1);
}
