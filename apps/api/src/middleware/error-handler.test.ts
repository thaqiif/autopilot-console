/**
 * RED tests for error-handler requirement 21 gaps.
 *
 * The current buildFailure hardcodes process.env.NODE_ENV rather than
 * accepting it as an injectable parameter, which makes production-mode
 * error handling untestable. These tests fail until buildFailure accepts
 * an explicit nodeEnv argument.
 */

import { describe, expect, test } from "bun:test";
import { buildFailure, createNormalizedError } from "./error-handler";

describe("error handler (requirement 21 acceptance gaps)", () => {
	test("production mode hides internal error messages", () => {
		const error = new Error("secret stack trace: password=abc123");
		const body = buildFailure(error, "corr-1", "production");
		expect(body.error.message).not.toContain("secret");
		expect(body.error.message).not.toContain("password");
		expect(body.error.message).not.toContain("stack");
		expect(body.error.code).toBe("INTERNAL");
		expect(body.error.httpStatus).toBe(500);
		expect(body.error.correlationId).toBe("corr-1");
	});

	test("production mode exposes safe next action for internal errors", () => {
		const error = new Error("internal crash: oom");
		const body = buildFailure(error, "corr-2", "production");
		expect(body.error.nextAction).toBeDefined();
		expect(body.error.nextAction.length).toBeGreaterThan(0);
	});

	test("development mode preserves original error message", () => {
		const error = new Error("validation detail: field X is required");
		const body = buildFailure(error, "corr-3", "development");
		expect(body.error.message).toContain("field X");
	});

	test("normalized errors preserve their typed envelope regardless of environment", () => {
		const ne = createNormalizedError({
			code: "NOT_FOUND",
			message: "Release not found.",
			httpStatus: 404,
			correlationId: "corr-4",
		});
		const body = buildFailure(ne, "corr-4", "production");
		expect(body.error.code).toBe("NOT_FOUND");
		expect(body.error.httpStatus).toBe(404);
		expect(body.error.message).toBe("Release not found.");
		expect(body.error.correlationId).toBe("corr-4");
	});

	test("handles error with no message property safely", () => {
		// biome-ignore lint/suspicious/noExplicitAny: intentional unsafe input test
		const weird = {} as any;
		const body = buildFailure(weird, "corr-5", "production");
		expect(body.error.code).toBe("INTERNAL");
		expect(body.error.httpStatus).toBe(500);
	});
});
