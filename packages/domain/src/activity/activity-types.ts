/** Activity event types for progress observation (requirement 18). */

export interface ActivityEventRow {
	id: string;
	projectId: string | null;
	featureId: string | null;
	attemptId: string | null;
	type: string;
	summary: string;
	source: string;
	metadata: unknown;
	occurredAt: Date;
	createdAt: Date;
}

export interface ActivityPage {
	items: ActivityEventRow[];
	nextCursor: string | null;
}
