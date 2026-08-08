/**
 * Feature domain entity shapes (F-4).
 */

import type { FeatureState } from "./feature-state";

export interface Feature {
	id: string;
	projectId: string;
	releaseId: string;
	slug: string;
	title: string;
	summary: string | null;
	state: FeatureState;
	branchName: string;
	taskPath: string | null;
	rowVersion: number;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export type { FeatureState };
