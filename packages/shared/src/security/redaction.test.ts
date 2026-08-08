import { describe, expect, test } from "bun:test";
import { redactSecrets, redactValue } from "./redaction";

describe("redactSecrets", () => {
	test("redacts Authorization headers and bearer tokens", () => {
		const input = [
			"Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"authorization: Basic dXNlcjpwYXNz",
			'{"authorization":"Bearer secret-token-value"}',
		].join("\n");
		const out = redactSecrets(input);
		expect(out).not.toContain("ghp_");
		expect(out).not.toContain("secret-token-value");
		expect(out).not.toContain("dXNlcjpwYXNz");
		expect(out).toMatch(/\[REDACTED\]/);
	});

	test("redacts cookies", () => {
		const input = "Cookie: session=abc123supersecret; other=value\nSet-Cookie: sid=xyz; HttpOnly";
		const out = redactSecrets(input);
		expect(out).not.toContain("abc123supersecret");
		expect(out).not.toContain("sid=xyz");
		expect(out).toMatch(/\[REDACTED\]/);
	});

	test("redacts access tokens and passwords in key=value and JSON forms", () => {
		const input = [
			"access_token=ya29.a0AfH6SMBxampletoken",
			'password: "hunter2-secret"',
			'{"accessToken":"tok_live_abcdef","password":"s3cret!"}',
			"GITHUB_TOKEN=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
			"client_secret=shhh_dont_leak",
		].join("\n");
		const out = redactSecrets(input);
		expect(out).not.toContain("ya29.");
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("tok_live_abcdef");
		expect(out).not.toContain("s3cret!");
		expect(out).not.toContain("gho_");
		expect(out).not.toContain("shhh_dont_leak");
	});

	test("redacts GitHub tokens in free text", () => {
		const tokens = [
			"ghp_1234567890abcdefghijklmnopqrstuvwx",
			"gho_1234567890abcdefghijklmnopqrstuvwx",
			"ghs_1234567890abcdefghijklmnopqrstuvwx",
			"github_pat_11AAAAAAA_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
		];
		const out = redactSecrets(`tokens: ${tokens.join(" ")}`);
		for (const t of tokens) {
			expect(out).not.toContain(t);
		}
		expect(out).toMatch(/\[REDACTED\]/);
	});

	test("redacts credential-bearing URLs", () => {
		const input = [
			"clone https://user:p@ssw0rd@github.com/org/repo.git",
			"postgres://admin:dbpass@db.internal:5432/app",
			"git@github.com:org/repo.git stays",
		].join("\n");
		const out = redactSecrets(input);
		expect(out).not.toContain("p@ssw0rd");
		expect(out).not.toContain("dbpass");
		expect(out).not.toContain("user:p");
		expect(out).toContain("github.com/org/repo.git");
		expect(out).toContain("git@github.com:org/repo.git stays");
	});

	test("preserves non-secret lookalikes (false-positive preservation)", () => {
		const input = [
			"The password policy requires 12 characters.",
			"authorization of the request succeeded",
			"token count is 3",
			"cookie jar implementation",
			"access_token_type field is bearer",
		].join("\n");
		const out = redactSecrets(input);
		expect(out).toContain("password policy requires 12 characters");
		expect(out).toContain("authorization of the request succeeded");
		expect(out).toContain("token count is 3");
		expect(out).toContain("cookie jar implementation");
		expect(out).toContain("access_token_type field is bearer");
	});
});

describe("redactValue", () => {
	test("redacts nested objects and arrays without mutating the original", () => {
		const original = {
			user: "alice",
			password: "s3cret",
			headers: {
				Authorization: "Bearer abc",
				"Content-Type": "application/json",
			},
			items: [{ token: "tok_1" }, { name: "ok" }],
			url: "https://u:p@host/path",
		};
		const clone = structuredClone(original);
		const redacted = redactValue(original) as typeof original;

		expect(original).toEqual(clone);
		expect(redacted.password).toBe("[REDACTED]");
		expect(redacted.headers.Authorization).toBe("[REDACTED]");
		expect(redacted.headers["Content-Type"]).toBe("application/json");
		expect(redacted.items[0]?.token).toBe("[REDACTED]");
		expect(redacted.items[1]?.name).toBe("ok");
		expect(redacted.url).not.toContain("u:p@");
		expect(redacted.user).toBe("alice");
	});
});
