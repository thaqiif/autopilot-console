/**
 * Versioned autopilot task-file wire types.
 * Compatible unknown fields are retained as index signatures on plain objects.
 */

/** Console-supported task schema compatibility version (I-2). */
export const TASK_SCHEMA_COMPATIBILITY_VERSION = "autopilotagent-tasks-1" as const;

export type TaskRunMode = "fresh" | "resumable" | "complete";

export interface TddPhaseWire {
	description?: string;
	file?: string;
	passes: boolean;
	[key: string]: unknown;
}

export interface TddWire {
	test: TddPhaseWire;
	implement: TddPhaseWire;
	refactor: TddPhaseWire;
	[key: string]: unknown;
}

export interface RequirementWire {
	id: string;
	description: string;
	category?: string;
	priority?: string;
	dependsOn?: string[];
	testType?: string;
	issue?: string;
	package?: string;
	acceptance?: string[];
	verification?: string[];
	tdd?: TddWire;
	passes: boolean;
	stuck?: boolean;
	blockedReason?: string;
	invalidTest?: boolean;
	invalidTestReason?: string;
	codeAnalysis?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface TaskDocument {
	name: string;
	description: string;
	goals?: string[];
	nonGoals?: string[];
	technicalNotes?: string;
	$schema?: string;
	_tdd?: boolean;
	_priority_order?: string[];
	_step_size?: string;
	requirements: RequirementWire[];
	[key: string]: unknown;
}

export type ValidationOk = {
	ok: true;
	document: TaskDocument;
	runMode: TaskRunMode;
};

export type ValidationErr = {
	ok: false;
	errors: string[];
};

export type ValidationResult = ValidationOk | ValidationErr;
