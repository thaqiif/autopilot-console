import type { FeatureState } from "../feature/feature-state";

/** Phase 1 release development statuses (F-3). Never production-ready/released. */
export const RELEASE_DEVELOPMENT_STATUSES = [
	"Planned",
	"In Development",
	"Development Merged",
] as const;

export type ReleaseDevelopmentStatus = (typeof RELEASE_DEVELOPMENT_STATUSES)[number];

export interface FeatureForProgress {
	id: string;
	state: FeatureState;
	archived: boolean;
}

export interface DevelopmentProgress {
	/** Non-archived feature count. */
	total: number;
	/** Non-archived features in DEVELOPMENT_MERGED. */
	merged: number;
	/** merged / total, or 0 when total is 0. */
	ratio: number;
	/** Floor of ratio * 100. */
	percent: number;
	status: ReleaseDevelopmentStatus;
	/** UI metric label — always "development progress". */
	label: "development progress";
}

/**
 * Pure release development progress.
 * DEVELOPMENT_MERGED / non-archived features; never implies production release.
 */
export function computeDevelopmentProgress(
	features: readonly FeatureForProgress[],
): DevelopmentProgress {
	let total = 0;
	let merged = 0;
	let anyNonPlanned = false;

	for (const f of features) {
		if (f.archived) continue;
		total += 1;
		if (f.state === "DEVELOPMENT_MERGED") {
			merged += 1;
		} else if (f.state !== "PLANNED") {
			anyNonPlanned = true;
		}
	}

	const ratio = total === 0 ? 0 : merged / total;
	const percent = Math.floor(ratio * 100);

	let status: ReleaseDevelopmentStatus;
	if (total === 0 || (merged === 0 && !anyNonPlanned)) {
		status = "Planned";
	} else if (merged === total) {
		status = "Development Merged";
	} else {
		status = "In Development";
	}

	return {
		total,
		merged,
		ratio,
		percent,
		status,
		label: "development progress",
	};
}
