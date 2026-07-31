/**
 * RED tests for GitHubGateway gh CLI adapter (requirement 11).
 * Fake gh only — no network, no real credentials.
 */

import { afterEach, describe, expect, test } from "bun:test";
// Implementation under test — imported after tests define expected surface.
// Will fail to resolve methods until Green.
import { GhCliGateway } from "./gh-cli-gateway";
import type { GitHubGateway } from "./github-gateway";
import { createFakeGh, errorResponse, jsonResponse, textResponse } from "./testing/fake-gh";

const repo = {
	owner: "acme",
	repository: "widget",
	fullName: "acme/widget",
} as const;

function gateway(fake = createFakeGh()): {
	gw: GitHubGateway;
	fake: ReturnType<typeof createFakeGh>;
} {
	const gw = new GhCliGateway({
		runGh: (argv, opts) => fake.run(argv, opts),
	});
	return { gw, fake };
}

afterEach(() => {
	// no shared state
});

describe("GitHubGateway public API surface", () => {
	test("exposes only authentication, access, find, create, and status operations", () => {
		const { gw } = gateway();
		const g = gw as unknown as Record<string, unknown>;
		expect(typeof g.validateAuthentication).toBe("function");
		expect(typeof g.validateAccess).toBe("function");
		expect(typeof g.findExistingPullRequest).toBe("function");
		expect(typeof g.createPullRequest).toBe("function");
		expect(typeof g.getPullRequestStatus).toBe("function");
		for (const verb of [
			"approve",
			"merge",
			"mergePullRequest",
			"approvePullRequest",
			"close",
			"runArbitrary",
			"exec",
			"raw",
		]) {
			expect(g[verb]).toBeUndefined();
		}
	});
});

describe("validateAccess", () => {
	test("reports authenticated login and readable repository", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				hosts: {
					"github.com": {
						accounts: {
							alice: { state: "success" },
						},
						activeAccount: "alice",
					},
				},
			}),
			// repo view JSON
			jsonResponse({
				name: "widget",
				owner: { login: "acme" },
				viewerPermission: "WRITE",
			}),
		);

		const result = await gw.validateAccess({ repository: repo });
		expect(result.ok).toBe(true);
		expect(result.authenticated).toBe(true);
		expect(result.login).toBe("alice");
		expect(result.repositoryReadable).toBe(true);
		expect(result.pushFeasible).toBe(true);
		expect(result.failures).toEqual([]);

		// Fixed argv: auth status --json hosts; api or repo view with --json
		expect(fake.calls.length).toBeGreaterThanOrEqual(2);
		expect(fake.calls[0]?.argv).toContain("auth");
		expect(fake.calls[0]?.argv).toContain("--json");
		// No shell-like strings
		for (const c of fake.calls) {
			expect(c.argv.join(" ")).not.toMatch(/[;&|`$]/);
		}
	});

	test("fails when gh is unauthenticated", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(errorResponse("You are not logged into any GitHub hosts. Run gh auth login.", 1));
		const result = await gw.validateAccess({ repository: repo });
		expect(result.ok).toBe(false);
		expect(result.authenticated).toBe(false);
		expect(result.failures.some((f) => f.code === "AUTH_REQUIRED")).toBe(true);
		const blob = JSON.stringify(result);
		expect(blob).not.toMatch(/ghp_[A-Za-z0-9]+/);
	});

	test("fails when repository is not readable", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				hosts: {
					"github.com": {
						accounts: { alice: { state: "success" } },
						activeAccount: "alice",
					},
				},
			}),
			errorResponse("HTTP 404: Not Found (https://api.github.com/repos/acme/widget)", 1),
		);
		const result = await gw.validateAccess({ repository: repo });
		expect(result.ok).toBe(false);
		expect(result.repositoryReadable).toBe(false);
		expect(result.failures.some((f) => f.code === "REPOSITORY_ACCESS_DENIED")).toBe(true);
	});

	test("redacts credential-bearing stderr from failures", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(
			errorResponse(
				"Authorization: Bearer ghp_supersecrettoken1234567890abcd failed for https://user:ghp_supersecrettoken1234567890abcd@github.com",
				1,
			),
		);
		const result = await gw.validateAccess({ repository: repo });
		const blob = JSON.stringify(result);
		expect(blob).not.toContain("ghp_supersecrettoken");
		expect(blob).not.toContain("Bearer ghp_");
	});
});

describe("findExistingPullRequest", () => {
	test("returns open PR matching exact head and base", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse([
				{
					number: 42,
					url: "https://github.com/acme/widget/pull/42",
					headRefName: "feature/feat-1-demo",
					baseRefName: "main",
					headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					state: "OPEN",
					title: "Demo",
				},
			]),
		);
		const found = await gw.findExistingPullRequest({
			repository: repo,
			headBranch: "feature/feat-1-demo",
			baseBranch: "main",
			state: "all",
		});
		expect(found).not.toBeNull();
		expect(found?.number).toBe(42);
		expect(found?.originalHeadSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(found?.headBranch).toBe("feature/feat-1-demo");
		expect(found?.baseBranch).toBe("main");
		expect(found?.url).toContain("/pull/42");
		// list must request JSON
		const listCall = fake.calls[0];
		expect(listCall?.argv).toContain("pr");
		expect(listCall?.argv).toContain("list");
		expect(listCall?.argv).toContain("--json");
		expect(listCall?.argv).toContain("--head");
		expect(listCall?.argv).toContain("feature/feat-1-demo");
	});

	test("distinguishes merged vs closed vs open", async () => {
		const { gw, fake } = gateway();
		// First: open empty
		fake.enqueue(jsonResponse([]));
		// closed/merged list with MERGED
		fake.enqueue(
			jsonResponse([
				{
					number: 7,
					url: "https://github.com/acme/widget/pull/7",
					headRefName: "feature/feat-1-demo",
					baseRefName: "main",
					headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					state: "MERGED",
					title: "Old",
				},
			]),
		);
		const found = await gw.findExistingPullRequest({
			repository: repo,
			headBranch: "feature/feat-1-demo",
			baseBranch: "main",
			state: "all",
		});
		expect(found?.number).toBe(7);
		expect(found?.originalHeadSha).toMatch(/^b+$/);
	});

	test("returns null when no matching PR", async () => {
		const { gw, fake } = gateway();
		// open + merged + closed probes
		fake.enqueue(jsonResponse([]), jsonResponse([]), jsonResponse([]));
		const found = await gw.findExistingPullRequest({
			repository: repo,
			headBranch: "feature/feat-1-demo",
			baseBranch: "main",
			state: "all",
		});
		expect(found).toBeNull();
	});

	test("rejects wrong base branch match", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse([
				{
					number: 9,
					url: "https://github.com/acme/widget/pull/9",
					headRefName: "feature/feat-1-demo",
					baseRefName: "develop",
					headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
					state: "OPEN",
				},
			]),
		);
		const found = await gw.findExistingPullRequest({
			repository: repo,
			headBranch: "feature/feat-1-demo",
			baseBranch: "main",
			state: "open",
		});
		expect(found).toBeNull();
	});
});

describe("createPullRequest", () => {
	test("creates PR then loads identity via pr view JSON", async () => {
		const { gw, fake } = gateway();
		// create prints URL only (no --json on create)
		fake.enqueue(
			textResponse("https://github.com/acme/widget/pull/55\n", 0),
			jsonResponse({
				number: 55,
				url: "https://github.com/acme/widget/pull/55",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: "dddddddddddddddddddddddddddddddddddddddd",
				state: "OPEN",
				title: "Add feature",
			}),
		);
		const id = await gw.createPullRequest({
			repository: repo,
			headBranch: "feature/feat-1-demo",
			baseBranch: "main",
			title: "Add feature",
			body: "Automated by Autopilot Console",
		});
		expect(id.number).toBe(55);
		expect(id.originalHeadSha).toBe("dddddddddddddddddddddddddddddddddddddddd");
		expect(id.headBranch).toBe("feature/feat-1-demo");
		expect(id.baseBranch).toBe("main");
		expect(id.repository.fullName).toBe("acme/widget");

		const createCall = fake.calls[0];
		expect(createCall?.argv).toContain("pr");
		expect(createCall?.argv).toContain("create");
		expect(createCall?.argv).not.toContain("--json");
		expect(createCall?.argv).toContain("--title");
		expect(createCall?.argv).toContain("--body");
		expect(createCall?.argv).toContain("--head");
		expect(createCall?.argv).toContain("--base");
		// no interactive flags
		expect(createCall?.argv).not.toContain("--web");
		expect(createCall?.argv).not.toContain("--editor");

		const viewCall = fake.calls[1];
		expect(viewCall?.argv).toContain("view");
		expect(viewCall?.argv).toContain("--json");
		expect(viewCall?.argv).toContain("55");
	});

	test("rejects malformed view JSON after create with normalized adapter error", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(
			textResponse("https://github.com/acme/widget/pull/1\n", 0),
			textResponse("Open\tAdd feature\n", 0),
		);
		await expect(
			gw.createPullRequest({
				repository: repo,
				headBranch: "feature/feat-1-demo",
				baseBranch: "main",
				title: "x",
				body: "y",
			}),
		).rejects.toMatchObject({ code: "ADAPTER_ERROR" });
	});

	test("redacts secrets from create failure", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(errorResponse("token=ghp_supersecrettoken1234567890abcd denied", 1));
		try {
			await gw.createPullRequest({
				repository: repo,
				headBranch: "feature/feat-1-demo",
				baseBranch: "main",
				title: "x",
				body: "y",
			});
			expect.unreachable("should throw");
		} catch (e) {
			const msg = JSON.stringify(e);
			expect(msg).not.toContain("ghp_supersecrettoken");
		}
	});
});

describe("getPullRequestStatus", () => {
	test("normalizes pending checks for current head only", async () => {
		const head = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 10,
				url: "https://github.com/acme/widget/pull/10",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "OPEN",
				reviewDecision: "",
				mergeCommit: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: "2026-07-18T00:00:00Z",
				mergeable: "MERGEABLE",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						name: "ci",
						status: "IN_PROGRESS",
						conclusion: null,
						detailsUrl: "https://example.com/ci",
					},
				],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 10 });
		expect(status.state).toBe("open");
		expect(status.currentHeadSha).toBe(head);
		expect(status.checkSummary).toBe("pending");
		expect(status.checks.every((c) => c.headSha === head)).toBe(true);
		expect(status.reviewDecision).toBe("NONE");
		expect(status.mergeCommitSha).toBeNull();

		const viewCall = fake.calls[0];
		expect(viewCall?.argv).toContain("pr");
		expect(viewCall?.argv).toContain("view");
		expect(viewCall?.argv).toContain("--json");
	});

	test("normalizes passing checks", async () => {
		const head = "ffffffffffffffffffffffffffffffffffffffff";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 11,
				url: "https://github.com/acme/widget/pull/11",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "OPEN",
				reviewDecision: "REVIEW_REQUIRED",
				mergeCommit: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: "2026-07-18T00:00:00Z",
				mergeable: "MERGEABLE",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						name: "ci",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 11 });
		expect(status.checkSummary).toBe("passing");
		expect(status.reviewDecision).toBe("REVIEW_REQUIRED");
	});

	test("normalizes failing checks", async () => {
		const head = "1111111111111111111111111111111111111111";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 12,
				url: "https://github.com/acme/widget/pull/12",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "OPEN",
				reviewDecision: "",
				mergeCommit: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: "2026-07-18T00:00:00Z",
				mergeable: "MERGEABLE",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						name: "ci",
						status: "COMPLETED",
						conclusion: "FAILURE",
					},
				],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 12 });
		expect(status.checkSummary).toBe("failing");
	});

	test("empty checks map to none (eligible for PR review when open)", async () => {
		const head = "2222222222222222222222222222222222222222";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 13,
				url: "https://github.com/acme/widget/pull/13",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "OPEN",
				reviewDecision: "",
				mergeCommit: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: "2026-07-18T00:00:00Z",
				mergeable: "MERGEABLE",
				statusCheckRollup: [],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 13 });
		expect(status.checkSummary).toBe("none");
		expect(status.checks).toEqual([]);
	});

	test("requested changes review decision", async () => {
		const head = "3333333333333333333333333333333333333333";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 14,
				url: "https://github.com/acme/widget/pull/14",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "OPEN",
				reviewDecision: "CHANGES_REQUESTED",
				mergeCommit: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: "2026-07-18T00:00:00Z",
				mergeable: "MERGEABLE",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						name: "ci",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 14 });
		expect(status.reviewDecision).toBe("CHANGES_REQUESTED");
		expect(status.checkSummary).toBe("passing");
	});

	test("merged PR includes merge commit", async () => {
		const head = "4444444444444444444444444444444444444444";
		const merge = "5555555555555555555555555555555555555555";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 15,
				url: "https://github.com/acme/widget/pull/15",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "MERGED",
				reviewDecision: "APPROVED",
				mergeCommit: { oid: merge },
				mergedAt: "2026-07-18T01:00:00Z",
				closedAt: "2026-07-18T01:00:00Z",
				updatedAt: "2026-07-18T01:00:00Z",
				mergeable: "UNKNOWN",
				statusCheckRollup: [],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 15 });
		expect(status.state).toBe("merged");
		expect(status.mergeCommitSha).toBe(merge);
		expect(status.mergedAt).toBe("2026-07-18T01:00:00Z");
	});

	test("closed without merge", async () => {
		const head = "6666666666666666666666666666666666666666";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 16,
				url: "https://github.com/acme/widget/pull/16",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "CLOSED",
				reviewDecision: "",
				mergeCommit: null,
				mergedAt: null,
				closedAt: "2026-07-18T02:00:00Z",
				updatedAt: "2026-07-18T02:00:00Z",
				mergeable: "UNKNOWN",
				statusCheckRollup: [],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 16 });
		expect(status.state).toBe("closed");
		expect(status.mergeCommitSha).toBeNull();
		expect(status.closedAt).toBe("2026-07-18T02:00:00Z");
	});

	test("head SHA change is reflected in currentHeadSha", async () => {
		const head = "7777777777777777777777777777777777777777";
		const { gw, fake } = gateway();
		fake.enqueue(
			jsonResponse({
				number: 17,
				url: "https://github.com/acme/widget/pull/17",
				headRefName: "feature/feat-1-demo",
				baseRefName: "main",
				headRefOid: head,
				state: "OPEN",
				reviewDecision: "",
				mergeCommit: null,
				mergedAt: null,
				closedAt: null,
				updatedAt: "2026-07-18T03:00:00Z",
				mergeable: "MERGEABLE",
				statusCheckRollup: [],
			}),
		);
		const status = await gw.getPullRequestStatus({ repository: repo, number: 17 });
		expect(status.currentHeadSha).toBe(head);
	});

	test("rejects human-formatted gh output", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(textResponse("Open\tAdd feature\tfeature/x\tmain\n", 0));
		await expect(gw.getPullRequestStatus({ repository: repo, number: 1 })).rejects.toMatchObject({
			code: "ADAPTER_ERROR",
		});
	});

	test("rejects malformed JSON object missing required fields", async () => {
		const { gw, fake } = gateway();
		fake.enqueue(jsonResponse({ number: 1 }));
		await expect(gw.getPullRequestStatus({ repository: repo, number: 1 })).rejects.toMatchObject({
			code: "ADAPTER_ERROR",
		});
	});
});

describe("no approve or merge operations", () => {
	test("implementation source must not spawn merge or review approve", async () => {
		// Runtime surface already checked; also ensure create/list/view never include merge verbs.
		const { gw, fake } = gateway();
		fake.enqueue(jsonResponse([]), jsonResponse([]), jsonResponse([]));
		await gw.findExistingPullRequest({
			repository: repo,
			headBranch: "feature/x",
			baseBranch: "main",
			state: "all",
		});
		for (const c of fake.calls) {
			expect(c.argv).not.toContain("merge");
			expect(c.argv).not.toContain("approve");
			expect(c.argv.join(" ")).not.toMatch(/\bpr merge\b/);
			expect(c.argv.join(" ")).not.toMatch(/\bpr review\b/);
		}
	});
});
