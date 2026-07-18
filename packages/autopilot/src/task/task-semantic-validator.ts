/**
 * Semantic validation for autopilot task documents.
 * Single dependency-graph traversal for missing refs + cycles.
 */

import type {
	RequirementWire,
	TaskDocument,
	TaskRunMode,
	TddWire,
	ValidationResult,
} from "./task-schema";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((item) => typeof item === "string")) return null;
	return value as string[];
}

function parseTdd(raw: unknown, reqId: string, errors: string[]): TddWire | undefined {
	if (raw === undefined) return undefined;
	if (!isPlainObject(raw)) {
		errors.push(`Requirement ${reqId}: tdd must be an object`);
		return undefined;
	}
	const phases = ["test", "implement", "refactor"] as const;
	const out: Record<string, unknown> = { ...raw };
	for (const phase of phases) {
		const p = raw[phase];
		if (!isPlainObject(p)) {
			errors.push(`Requirement ${reqId}: tdd.${phase} is required`);
			continue;
		}
		if (typeof p.passes !== "boolean") {
			errors.push(`Requirement ${reqId}: tdd.${phase}.passes must be boolean`);
		}
		out[phase] = { ...p };
	}
	return out as TddWire;
}

function parseRequirement(raw: unknown, index: number, errors: string[]): RequirementWire | null {
	if (!isPlainObject(raw)) {
		errors.push(`Requirement at index ${index} must be an object`);
		return null;
	}
	const id = raw.id;
	if (typeof id !== "string" || id.length === 0) {
		errors.push(`Requirement at index ${index} is missing a non-empty id`);
		return null;
	}
	if (typeof raw.description !== "string") {
		errors.push(`Requirement ${id}: description is required`);
	}
	if (typeof raw.passes !== "boolean") {
		errors.push(`Requirement ${id}: passes must be boolean`);
	}

	if (raw.dependsOn !== undefined) {
		const deps = asStringArray(raw.dependsOn);
		if (deps === null) {
			errors.push(`Requirement ${id}: dependsOn must be an array of strings`);
		}
	}

	const tdd = parseTdd(raw.tdd, id, errors);

	if (raw.stuck === true) {
		if (typeof raw.blockedReason !== "string" || raw.blockedReason.length === 0) {
			errors.push(`Requirement ${id}: stuck requires blockedReason`);
		}
	}
	if (raw.invalidTest === true) {
		if (typeof raw.invalidTestReason !== "string" || raw.invalidTestReason.length === 0) {
			errors.push(`Requirement ${id}: invalidTest requires invalidTestReason`);
		}
	}

	// Impossible fresh/resumable: overall passes true while a TDD phase is false.
	if (raw.passes === true && tdd) {
		const phases = [tdd.test, tdd.implement, tdd.refactor];
		if (phases.some((p) => p && p.passes === false)) {
			errors.push(
				`Requirement ${id}: impossible state — passes is true but a TDD phase is incomplete`,
			);
		}
	}

	// Preserve all wire fields (unknowns included).
	return {
		...(raw as RequirementWire),
		id,
		description: typeof raw.description === "string" ? raw.description : "",
		passes: raw.passes === true,
		tdd,
	};
}

/**
 * Detect missing dependency IDs and cycles with one adjacency build + DFS.
 */
export function validateDependencyGraph(requirements: readonly RequirementWire[]): string[] {
	const errors: string[] = [];
	const ids = new Set(requirements.map((r) => r.id));
	const adj = new Map<string, string[]>();

	for (const req of requirements) {
		const deps = req.dependsOn ?? [];
		const resolved: string[] = [];
		for (const dep of deps) {
			if (!ids.has(dep)) {
				errors.push(`Requirement ${req.id}: missing dependency "${dep}"`);
			} else {
				resolved.push(dep);
			}
		}
		adj.set(req.id, resolved);
	}

	// Cycle detection: white/gray/black DFS
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const id of ids) color.set(id, WHITE);

	const stack: string[] = [];

	function dfs(node: string): boolean {
		color.set(node, GRAY);
		stack.push(node);
		for (const next of adj.get(node) ?? []) {
			const c = color.get(next) ?? WHITE;
			if (c === GRAY) {
				const cycleStart = stack.indexOf(next);
				const cycle = [...stack.slice(cycleStart), next].join(" -> ");
				errors.push(`Dependency cycle detected: ${cycle}`);
				return true;
			}
			if (c === WHITE && dfs(next)) return true;
		}
		stack.pop();
		color.set(node, BLACK);
		return false;
	}

	for (const id of ids) {
		if ((color.get(id) ?? WHITE) === WHITE) {
			dfs(id);
		}
	}

	return errors;
}

function deriveRunMode(requirements: readonly RequirementWire[]): TaskRunMode {
	if (requirements.length === 0) return "fresh";
	let anyPass = false;
	let allPass = true;
	for (const r of requirements) {
		if (r.passes) anyPass = true;
		else allPass = false;
	}
	if (allPass) return "complete";
	if (anyPass) return "resumable";
	return "fresh";
}

/**
 * Validate a parsed JSON value as an autopilot task document.
 * Does not mutate the input; returns a document with preserved unknown fields.
 */
export function validateTaskDocument(input: unknown): ValidationResult {
	const errors: string[] = [];

	if (!isPlainObject(input)) {
		return { ok: false, errors: ["Task document must be a JSON object"] };
	}

	if (typeof input.name !== "string" || input.name.length === 0) {
		errors.push("Missing required field: name");
	}
	if (typeof input.description !== "string") {
		errors.push("Missing required field: description");
	}
	if (!Array.isArray(input.requirements)) {
		errors.push("Missing required field: requirements");
		return { ok: false, errors };
	}

	const requirements: RequirementWire[] = [];
	const seenIds = new Set<string>();

	input.requirements.forEach((raw, index) => {
		const req = parseRequirement(raw, index, errors);
		if (!req) return;
		if (seenIds.has(req.id)) {
			errors.push(`Duplicate requirement id: ${req.id}`);
		}
		seenIds.add(req.id);
		requirements.push(req);
	});

	if (requirements.length === 0) {
		errors.push("Task file has no requirements; cannot represent a fresh or resumable run");
	}

	errors.push(...validateDependencyGraph(requirements));

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	// Preserve unknown top-level fields via spread of original object.
	const document: TaskDocument = {
		...(input as TaskDocument),
		name: input.name as string,
		description: input.description as string,
		requirements,
	};

	return {
		ok: true,
		document,
		runMode: deriveRunMode(requirements),
	};
}
