/**
 * @autopilot-console/autopilot
 * Task-file compatibility, semantic validation, approval snapshots, progress reads.
 */

export const packageName = "@autopilot-console/autopilot" as const;

export {
	type AtomicReadErr,
	type AtomicReadOk,
	type AtomicReadOptions,
	type AtomicReadResult,
	parseTaskBytes,
	readTaskFileAtomic,
} from "./task/task-reader";
export type {
	ParsedTaskBytes,
	ParseErr,
	ParseOk,
	ParseResult,
} from "./task/task-reader-types";
export type {
	RequirementWire,
	TaskDocument,
	TaskRunMode,
	ValidationResult,
} from "./task/task-schema";
export { TASK_SCHEMA_COMPATIBILITY_VERSION } from "./task/task-schema";
export { validateTaskDocument } from "./task/task-semantic-validator";
export {
	createTaskApprovalSnapshot,
	evaluateAllPass,
	type RequirementSummary,
	summarizeTaskFile,
	type TaskApprovalSnapshot,
	type TaskSummary,
} from "./task/task-snapshot";
