import { describe, expect, test } from "bun:test";
import { errorCodes } from "../errors/normalized-error";
import { type FeatureBranchName, generateFeatureBranch, sanitizeSlug } from "./feature-branch";
import {
	normalizeRepositoryIdentity,
	parseGitHubRemote,
	type RepositoryIdentity,
} from "./repository-identity";

describe("normalizeRepositoryIdentity / parseGitHubRemote", () => {
	test("normalizes owner/repo configuration", () => {
		const id = normalizeRepositoryIdentity({ owner: "Acme-Org", repository: "My-Repo" });
		expect(id.owner).toBe("Acme-Org");
		expect(id.repository).toBe("My-Repo");
		expect(id.fullName).toBe("Acme-Org/My-Repo");
		const branded: RepositoryIdentity = id;
		expect(String(branded.fullName)).toBe("Acme-Org/My-Repo");
	});

	test("rejects empty or invalid owner/repository", () => {
		expect(() => normalizeRepositoryIdentity({ owner: "", repository: "repo" })).toThrow(
			/owner|repository/i,
		);
		expect(() => normalizeRepositoryIdentity({ owner: "org", repository: "" })).toThrow(
			/owner|repository/i,
		);
		expect(() => normalizeRepositoryIdentity({ owner: "org/extra", repository: "repo" })).toThrow(
			/owner|repository|invalid/i,
		);
		expect(() => normalizeRepositoryIdentity({ owner: "org", repository: "repo/extra" })).toThrow(
			/owner|repository|invalid/i,
		);
	});

	test("parses https remote without exposing embedded credentials", () => {
		const id = parseGitHubRemote("https://github.com/acme/widgets.git");
		expect(id.owner).toBe("acme");
		expect(id.repository).toBe("widgets");
		expect(id.fullName).toBe("acme/widgets");

		const withCreds = parseGitHubRemote("https://user:p@ssw0rd@github.com/acme/widgets.git");
		expect(withCreds.fullName).toBe("acme/widgets");
		expect(JSON.stringify(withCreds)).not.toContain("p@ssw0rd");
		expect(JSON.stringify(withCreds)).not.toContain("user:");
	});

	test("parses ssh and git@ remotes", () => {
		expect(parseGitHubRemote("git@github.com:acme/widgets.git").fullName).toBe("acme/widgets");
		expect(parseGitHubRemote("ssh://git@github.com/acme/widgets.git").fullName).toBe(
			"acme/widgets",
		);
		expect(parseGitHubRemote("git@github.com:acme/widgets").fullName).toBe("acme/widgets");
	});

	test("rejects non-GitHub or malformed remotes", () => {
		expect(() => parseGitHubRemote("https://gitlab.com/acme/widgets.git")).toThrow(
			/github|remote/i,
		);
		expect(() => parseGitHubRemote("not-a-url")).toThrow(/remote|invalid/i);
		expect(() => parseGitHubRemote("")).toThrow(/remote|invalid/i);
	});

	test("normalized failures never include credential-bearing remote URL", () => {
		try {
			parseGitHubRemote("https://user:super-secret@gitlab.com/acme/widgets.git");
			expect.unreachable("should reject");
		} catch (err) {
			const text = String(err) + JSON.stringify(err);
			expect(text).not.toContain("super-secret");
			if (err && typeof err === "object" && "code" in err) {
				expect((err as { code: string }).code).toBe(errorCodes.VALIDATION_FAILED);
			}
		}
	});
});

describe("sanitizeSlug", () => {
	test("lowercases and replaces unsafe characters", () => {
		expect(sanitizeSlug("Hello World!")).toBe("hello-world");
		expect(sanitizeSlug("  Foo_Bar  ")).toBe("foo-bar");
		expect(sanitizeSlug("a--b___c")).toBe("a-b-c");
	});

	test("rejects empty result after sanitization", () => {
		expect(() => sanitizeSlug("!!!")).toThrow(/slug/i);
		expect(() => sanitizeSlug("")).toThrow(/slug/i);
	});
});

describe("generateFeatureBranch", () => {
	test("produces feature/<feature-id>-<sanitized-slug>", () => {
		const branch = generateFeatureBranch({
			featureId: "feat_01HXYZABC",
			slug: "User Auth",
		});
		expect(String(branch)).toBe("feature/feat_01HXYZABC-user-auth");
		const branded: FeatureBranchName = branch;
		expect(String(branded)).toBe(String(branch));
	});

	test("is stable across retries with the same inputs", () => {
		const a = generateFeatureBranch({ featureId: "feat_1", slug: "login-form" });
		const b = generateFeatureBranch({ featureId: "feat_1", slug: "login-form" });
		expect(a).toBe(b);
		expect(String(a)).toBe("feature/feat_1-login-form");
	});

	test("distinct feature IDs remain distinct when titles sanitize to the same slug", () => {
		const a = generateFeatureBranch({ featureId: "feat_aaa", slug: "Hello World" });
		const b = generateFeatureBranch({ featureId: "feat_bbb", slug: "hello-world" });
		expect(a).not.toBe(b);
		expect(String(a)).toBe("feature/feat_aaa-hello-world");
		expect(String(b)).toBe("feature/feat_bbb-hello-world");
	});

	test("rejects empty or unsafe feature id / slug output", () => {
		expect(() => generateFeatureBranch({ featureId: "", slug: "x" })).toThrow(/feature|id/i);
		expect(() => generateFeatureBranch({ featureId: "feat_1", slug: "!!!" })).toThrow(/slug/i);
		expect(() => generateFeatureBranch({ featureId: "feat/../evil", slug: "ok" })).toThrow(
			/feature|id|invalid|ref/i,
		);
	});

	test("output is a valid Git ref component shape (no spaces, dots at ends, double dots)", () => {
		const samples = [
			{ featureId: "feat_01", slug: "Simple" },
			{ featureId: "feat_02", slug: "with spaces and CAPS" },
			{ featureId: "feat_03", slug: "dots...and---dashes" },
			{ featureId: "feat_04", slug: "under_score_ok" },
			{ featureId: "id-with-hyphen", slug: "slug" },
		];
		for (const sample of samples) {
			const branch = generateFeatureBranch(sample);
			expect(branch.startsWith("feature/")).toBe(true);
			expect(branch).not.toMatch(/\s/);
			expect(branch).not.toMatch(/\.\./);
			expect(branch).not.toMatch(/\/$/);
			expect(branch).not.toMatch(/^\./);
			expect(branch).not.toMatch(/\/\./);
			// no control or shell-ish characters
			expect(branch).not.toMatch(/[~^:?*[\\]/);
		}
	});

	test("property: random alphanumeric ids and titles always yield valid feature/ refs", () => {
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.";
		for (let i = 0; i < 40; i++) {
			const idLen = 3 + (i % 12);
			const featureId = `f${i}_${Array.from(
				{ length: idLen },
				(_, j) => "abc123"[(i + j) % 6],
			).join("")}`;
			const titleLen = 1 + (i % 20);
			const slug = Array.from(
				{ length: titleLen },
				(_, j) => alphabet[(i * 7 + j) % alphabet.length],
			).join("");
			// skip pure-punctuation titles that sanitize empty — those must throw
			const hasAlnum = /[A-Za-z0-9]/.test(slug);
			if (!hasAlnum) {
				expect(() => generateFeatureBranch({ featureId, slug })).toThrow();
				continue;
			}
			const branch = generateFeatureBranch({ featureId, slug });
			expect(branch).toMatch(/^feature\/[A-Za-z0-9][A-Za-z0-9._-]*-[a-z0-9]+(?:-[a-z0-9]+)*$/);
			// re-run stable
			expect(generateFeatureBranch({ featureId, slug })).toBe(branch);
		}
	});
});
