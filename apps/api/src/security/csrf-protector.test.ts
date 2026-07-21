import { describe, expect, test } from "bun:test";
import { createCsrfProtector } from "./csrf-protector";

describe("session-bound CSRF protection", () => {
	test("accepts only a token issued for the authenticated session", () => {
		const csrf = createCsrfProtector();
		const issued = csrf.issue("session-a");

		expect(
			csrf.validate({
				sessionCookie: "ac_session=session-a",
				csrfCookie: null,
				csrfHeader: issued,
			}),
		).toBe(true);
		expect(
			csrf.validate({
				sessionCookie: "ac_session=session-b",
				csrfCookie: null,
				csrfHeader: issued,
			}),
		).toBe(false);
	});

	test("rejects matching attacker-controlled CSRF cookie and header values", () => {
		const csrf = createCsrfProtector();

		expect(
			csrf.validate({
				sessionCookie: "ac_session=victim-session",
				csrfCookie: "attacker-value",
				csrfHeader: "attacker-value",
			}),
		).toBe(false);
	});

	test("revokes all issued tokens when a session logs out", () => {
		const csrf = createCsrfProtector();
		const issued = csrf.issue("session-a");
		csrf.revoke("session-a");

		expect(
			csrf.validate({
				sessionCookie: "ac_session=session-a",
				csrfCookie: null,
				csrfHeader: issued,
			}),
		).toBe(false);
	});
});
