/** Progress summary types for task snapshots (requirement 18). */

export interface TaskRequirementState {
	id: string;
	description: string;
	passes: boolean;
	stuck: boolean;
	invalidTest: boolean;
	blockedReason?: string | null;
	tdd?: {
		test?: { passes: boolean };
		implement?: { passes: boolean };
		refactor?: { passes: boolean };
	};
	dependsOn?: string[];
	acceptance?: string[];
}

export interface ProgressSummary {
	total: number;
	passed: number;
	stuck: number;
	invalidTest: number;
	remaining: number;
	allPass: boolean;
	blockedReasons: Array<{ id: string; reason: string }>;
	phaseSummary: { red: number; green: number; refactor: number };
	dependencySummary: { blocked: number; ready: number };
}

export interface ProgressSnapshotRow {
	id: string;
	projectId: string;
	featureId: string;
	attemptId: string;
	sourceVersion: number;
	summary: unknown;
	requirements: unknown;
	createdAt: Date;
}

export interface DiagnosticLogChunkRow {
	id: string;
	projectId: string;
	attemptId: string;
	sequence: number;
	stream: "stdout" | "stderr";
	body: string;
	truncated: boolean;
	createdAt: Date;
}

export interface TaskSnapshotInput {
	requirements: TaskRequirementState[];
	sourceVersion: number;
}
