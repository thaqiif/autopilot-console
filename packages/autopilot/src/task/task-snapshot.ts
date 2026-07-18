/**
 * Immutable approval snapshots and normalized task summaries.
 */

import type { ParsedTaskBytes } from "./task-reader-types";
import type { RequirementWire, TaskDocument } from "./task-schema";
import { TASK_SCHEMA_COMPATIBILITY_VERSION } from "./task-schema";

export interface TaskApprovalSnapshot {
	/** SHA-256 hex of exact source bytes. */
	checksum: string;
	schemaCompatibilityVersion: typeof TASK_SCHEMA_COMPATIBILITY_VERSION;
	/** Safe project-relative path. */
	relativePath: string;
	/** Deep-cloned requirements array as approved. */
	requirements: RequirementWire[];
	/** Full document deep-cloned for audit. */
	document: TaskDocument;
	/** Source byte length at approval time. */
	byteLength: number;
}

export interface RequirementSummary {
	id: string;
	description: string;
	dependsOn: string[];
	acceptance: string[];
	passes: boolean;
	stuck: boolean;
	invalidTest: boolean;
	blockedReason?: string;
	invalidTestReason?: string;
	tdd: {
		test: boolean;
		implement: boolean;
		refactor: boolean;
	};
}

export interface TaskSummary {
	name: string;
	description: string;
	goals: string[];
	nonGoals: string[];
	total: number;
	passed: number;
	stuck: number;
	invalidTest: number;
	pending: number;
	allPass: boolean;
	blockedReasons: Array<{ id: string; reason: string }>;
	requirements: RequirementSummary[];
}

function deepClone<T>(value: T): T {
	return structuredClone(value);
}

export function createTaskApprovalSnapshot(input: {
	parsed: ParsedTaskBytes;
	relativePath: string;
}): TaskApprovalSnapshot {
	const { parsed, relativePath } = input;
	return {
		checksum: parsed.checksum,
		schemaCompatibilityVersion: TASK_SCHEMA_COMPATIBILITY_VERSION,
		relativePath,
		requirements: deepClone(parsed.document.requirements),
		document: deepClone(parsed.document),
		byteLength: parsed.sourceBytes.byteLength,
	};
}

export function evaluateAllPass(document: TaskDocument): boolean {
	const reqs = document.requirements;
	if (reqs.length === 0) return false;
	return reqs.every((r) => r.passes === true);
}

export function summarizeTaskFile(document: TaskDocument): TaskSummary {
	const requirements: RequirementSummary[] = document.requirements.map((r) => {
		const tdd = r.tdd;
		return {
			id: r.id,
			description: r.description,
			dependsOn: r.dependsOn ? [...r.dependsOn] : [],
			acceptance: r.acceptance ? [...r.acceptance] : [],
			passes: r.passes === true,
			stuck: r.stuck === true,
			invalidTest: r.invalidTest === true,
			blockedReason: typeof r.blockedReason === "string" ? r.blockedReason : undefined,
			invalidTestReason: typeof r.invalidTestReason === "string" ? r.invalidTestReason : undefined,
			tdd: {
				test: tdd?.test?.passes === true,
				implement: tdd?.implement?.passes === true,
				refactor: tdd?.refactor?.passes === true,
			},
		};
	});

	let passed = 0;
	let stuck = 0;
	let invalidTest = 0;
	const blockedReasons: Array<{ id: string; reason: string }> = [];

	for (const r of requirements) {
		if (r.passes) passed += 1;
		if (r.stuck) {
			stuck += 1;
			if (r.blockedReason) {
				blockedReasons.push({ id: r.id, reason: r.blockedReason });
			}
		}
		if (r.invalidTest) invalidTest += 1;
	}

	const total = requirements.length;
	// Pending: incomplete work that is not stuck and not invalidTest.
	const pending = requirements.filter((r) => !r.passes && !r.stuck && !r.invalidTest).length;

	return {
		name: document.name,
		description: document.description,
		goals: Array.isArray(document.goals)
			? document.goals.filter((g): g is string => typeof g === "string")
			: [],
		nonGoals: Array.isArray(document.nonGoals)
			? document.nonGoals.filter((g): g is string => typeof g === "string")
			: [],
		total,
		passed,
		stuck,
		invalidTest,
		pending,
		allPass: evaluateAllPass(document),
		blockedReasons,
		requirements,
	};
}
