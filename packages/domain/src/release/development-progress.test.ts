import { describe, expect, test } from "bun:test";
import { FEATURE_STATES, type FeatureState } from "../feature/feature-state";
import {
	computeDevelopmentProgress,
	type FeatureForProgress,
	RELEASE_DEVELOPMENT_STATUSES,
} from "./development-progress";

function feature(
	state: FeatureState,
	opts: { archived?: boolean; id?: string } = {},
): FeatureForProgress {
	return {
		id: opts.id ?? `f-${state}`,
		state,
		archived: opts.archived ?? false,
	};
}

describe("computeDevelopmentProgress", () => {
	test("zero non-archived features yields ratio 0 and Planned status", () => {
		const result = computeDevelopmentProgress([]);
		expect(result.total).toBe(0);
		expect(result.merged).toBe(0);
		expect(result.ratio).toBe(0);
		expect(result.percent).toBe(0);
		expect(result.status).toBe("Planned");
		expect(result.label).toBe("development progress");
	});

	test("ignores archived features in denominator and numerator", () => {
		const result = computeDevelopmentProgress([
			feature("DEVELOPMENT_MERGED", { archived: true }),
			feature("PLANNED"),
			feature("DEVELOPMENT_MERGED"),
		]);
		expect(result.total).toBe(2);
		expect(result.merged).toBe(1);
		expect(result.ratio).toBe(0.5);
		expect(result.percent).toBe(50);
	});

	test("all non-archived DEVELOPMENT_MERGED → Development Merged and 100%", () => {
		const result = computeDevelopmentProgress([
			feature("DEVELOPMENT_MERGED", { id: "a" }),
			feature("DEVELOPMENT_MERGED", { id: "b" }),
		]);
		expect(result.total).toBe(2);
		expect(result.merged).toBe(2);
		expect(result.ratio).toBe(1);
		expect(result.percent).toBe(100);
		expect(result.status).toBe("Development Merged");
	});

	test("mixed lifecycle states yield In Development", () => {
		const result = computeDevelopmentProgress([
			feature("DEVELOPMENT_MERGED"),
			feature("DEVELOPING"),
			feature("PLANNED"),
		]);
		expect(result.merged).toBe(1);
		expect(result.total).toBe(3);
		expect(result.status).toBe("In Development");
		expect(result.percent).toBe(33);
	});

	test("only planned non-archived features stay Planned with 0%", () => {
		const result = computeDevelopmentProgress([
			feature("PLANNED", { id: "1" }),
			feature("PLANNED", { id: "2" }),
		]);
		expect(result.status).toBe("Planned");
		expect(result.merged).toBe(0);
		expect(result.percent).toBe(0);
	});

	test("never labels production-ready or released", () => {
		const result = computeDevelopmentProgress([feature("DEVELOPMENT_MERGED")]);
		const serialized = JSON.stringify(result).toLowerCase();
		expect(serialized).not.toContain("production");
		expect(serialized).not.toContain("released");
		expect(result.label).toBe("development progress");
		expect(RELEASE_DEVELOPMENT_STATUSES).toEqual([
			"Planned",
			"In Development",
			"Development Merged",
		]);
	});

	test("percent floors to integer for non-terminating ratios", () => {
		const result = computeDevelopmentProgress([
			feature("DEVELOPMENT_MERGED", { id: "m" }),
			feature("PLANNED", { id: "p1" }),
			feature("PLANNED", { id: "p2" }),
		]);
		expect(result.ratio).toBeCloseTo(1 / 3, 10);
		expect(result.percent).toBe(33);
	});

	test("every feature state is accepted without throwing", () => {
		for (const state of FEATURE_STATES) {
			expect(() => computeDevelopmentProgress([feature(state)])).not.toThrow();
		}
	});
});
