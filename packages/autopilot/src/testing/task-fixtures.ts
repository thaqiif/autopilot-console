/**
 * Minimal task JSON fixtures for unit tests.
 * Mirrors shapes from /opt/autopilot-multi/tests/fixtures and the full schema.
 */

export const SCHEMA_URL =
	"https://raw.githubusercontent.com/Gens-ai/autopilotagent/main/tasks.schema.json";

/** Full-schema requirement skeleton (tdd + verification present). */
export function fullRequirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const id = (overrides.id as string | undefined) ?? "1";
	return {
		id,
		category: "functional",
		description: `Requirement ${id}`,
		acceptance: [`Acceptance for ${id}`],
		tdd: {
			test: { description: `test ${id}`, passes: false },
			implement: { description: `implement ${id}`, passes: false },
			refactor: { description: `refactor ${id}`, passes: false },
		},
		verification: [`verify ${id}`],
		passes: false,
		...overrides,
	};
}

export function fullTaskFile(
	overrides: Record<string, unknown> = {},
	requirements?: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		$schema: SCHEMA_URL,
		name: "fixture-task",
		description: "Fixture task file",
		goals: ["goal-a"],
		nonGoals: ["non-goal-a"],
		_tdd: true,
		requirements: requirements ?? [fullRequirement({ id: "1" })],
		...overrides,
	};
}

/** Minimal fixture like autopilot-multi incomplete.json style. */
export function minimalRequirement(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const id = (overrides.id as string | undefined) ?? "1";
	return {
		id,
		description: `Requirement ${id}`,
		passes: false,
		...overrides,
	};
}

export function minimalTaskFile(
	overrides: Record<string, unknown> = {},
	requirements?: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		name: "minimal",
		description: "Minimal fixture",
		requirements: requirements ?? [minimalRequirement({ id: "1" })],
		...overrides,
	};
}
