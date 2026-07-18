import { describe, expect, test } from "bun:test";
import {
	aggregateValidationOk,
	PROJECT_VALIDATION_CHECK_CODES,
	type ProjectValidationCheck,
	touchesProtectedProjectFields,
} from "./project-validation";

function allOk(): ProjectValidationCheck[] {
	return PROJECT_VALIDATION_CHECK_CODES.map((code) => ({
		code,
		ok: true,
		message: "ok",
	}));
}

describe("touchesProtectedProjectFields", () => {
	test("true for path repo branch", () => {
		expect(touchesProtectedProjectFields({ workspacePath: "/x" })).toBe(true);
		expect(touchesProtectedProjectFields({ githubOwner: "a" })).toBe(true);
		expect(touchesProtectedProjectFields({ githubRepo: "b" })).toBe(true);
		expect(touchesProtectedProjectFields({ developmentBranch: "main" })).toBe(true);
	});

	test("false for safe fields only", () => {
		expect(touchesProtectedProjectFields({ name: "n", description: "d" })).toBe(false);
		expect(touchesProtectedProjectFields({ slug: "s" })).toBe(false);
		expect(touchesProtectedProjectFields({})).toBe(false);
	});
});

describe("aggregateValidationOk", () => {
	test("requires path and every check", () => {
		expect(aggregateValidationOk(allOk(), "/ws/p")).toBe(true);
		expect(aggregateValidationOk(allOk(), null)).toBe(false);
		const fail = allOk();
		const first = fail[0];
		if (!first) throw new Error("expected checks");
		fail[0] = { ...first, ok: false, message: "no" };
		expect(aggregateValidationOk(fail, "/ws/p")).toBe(false);
	});
});
