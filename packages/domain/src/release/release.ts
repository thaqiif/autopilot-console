/**
 * Release domain entity shapes (F-3).
 */

import type { ReleaseStatus as DbReleaseStatus } from "../../../database/src/schema/enums";

/** DB enum values for release status. */
export type ReleaseStatus = DbReleaseStatus;

export interface Release {
	id: string;
	projectId: string;
	name: string;
	version: string;
	description: string | null;
	sortOrder: number;
	status: ReleaseStatus;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}
