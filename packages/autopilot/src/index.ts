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
	createTaskApprovalSnapshot,
	evaluateAllPass,
	type ParsedTaskBytes,
	type ParseErr,
	type ParseOk,
	type ParseResult,
	parseTaskBytes,
	type RequirementSummary,
	type RequirementWire,
	readTaskFileAtomic,
	summarizeTaskFile,
	TASK_SCHEMA_COMPATIBILITY_VERSION,
	type TaskApprovalSnapshot,
	type TaskDocument,
	type TaskRunMode,
	type TaskSummary,
	type ValidationResult,
	validateTaskDocument,
} from "./task/task-reader";
