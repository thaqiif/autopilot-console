import { test as base, expect } from "@playwright/test";

const NOW = "2026-07-19T12:00:00.000Z";

const FEATURE_DETAIL = {
	id: "test-feature-1",
	title: "Example feature",
	slug: "example-feature",
	state: "DEVELOPING",
	branchName: "feature/example",
	projectId: "project-1",
	projectName: "Example project",
	releaseId: "release-1",
	releaseName: "Example release",
	summary: "Example feature summary",
	taskPath: "docs/autopilotagent/example/example.json",
	rowVersion: 1,
	taskApproval: {
		id: "approval-1",
		relativeTaskPath: "docs/autopilotagent/example/example.json",
		checksum: "abc123",
		requirementsSnapshot: {
			requirements: [
				{
					id: "1",
					description: "Bootstrap",
					status: "passed",
					passes: true,
					stuck: false,
					invalidTest: false,
					redPhase: true,
					greenPhase: true,
					refactorPhase: true,
					dependsOn: [],
					acceptance: ["Workspace boots"],
				},
			],
		},
		approvedAt: NOW,
	},
	progress: {
		totalRequirements: 2,
		passedRequirements: 1,
		activeRequirements: 1,
		stuckRequirements: 0,
		invalidRequirements: 0,
		remainingRequirements: 1,
		activeRequirementId: "2",
		lastUpdatedAt: NOW,
		requirements: [
			{
				id: "1",
				description: "Bootstrap",
				status: "passed",
				passes: true,
				stuck: false,
				invalidTest: false,
				redPhase: true,
				greenPhase: true,
				refactorPhase: true,
				dependsOn: [],
				acceptance: ["Workspace boots"],
			},
			{
				id: "2",
				description: "Harden mobile",
				status: "in_progress",
				passes: false,
				stuck: false,
				invalidTest: false,
				redPhase: true,
				greenPhase: false,
				refactorPhase: false,
				dependsOn: ["1"],
				acceptance: ["Works at 375x667"],
			},
		],
	},
	activeAttempt: {
		id: "attempt-1",
		status: "RUNNING",
		workerRegistrationId: "worker-1",
		worker: {
			workerId: "worker-1",
			hostname: "dev",
			capacity: 4,
			activeJobs: 1,
			lastHeartbeatAt: NOW,
		},
		heartbeatAt: NOW,
		enqueuedAt: NOW,
		startedAt: NOW,
		endedAt: null,
		exitCode: null,
		structuredResult: null,
		predecessorAttemptId: null,
	},
	attempts: [
		{
			id: "attempt-1",
			status: "RUNNING",
			workerRegistrationId: "worker-1",
			worker: {
				workerId: "worker-1",
				hostname: "dev",
				capacity: 4,
				activeJobs: 1,
				lastHeartbeatAt: NOW,
			},
			heartbeatAt: NOW,
			enqueuedAt: NOW,
			startedAt: NOW,
			endedAt: null,
			exitCode: null,
			structuredResult: null,
			predecessorAttemptId: null,
		},
	],
	failures: [
		{
			id: "failure-1",
			attemptId: "attempt-0",
			category: "PROCESS_EXIT",
			summary: "Prior attempt exited with code 1",
			recommendedAction: "Review logs and retry",
			occurredAt: NOW,
		},
	],
	diagnosticLogs: [
		{
			id: "log-1",
			body: "line one\nline two\nline three\nline four\nline five\nline six",
			truncated: true,
		},
	],
	pullRequest: {
		number: 42,
		url: "https://github.com/example/repo/pull/42",
		observedState: "OPEN",
		observedHeadSha: "deadbeef",
		mergeCommitSha: null,
		lastObservedAt: NOW,
	},
	recentActivity: [
		{
			id: "activity-1",
			type: "job.progress",
			summary: "Requirement 2 started",
			occurredAt: NOW,
		},
	],
};

export const test = base.extend<{ mockApi: undefined }>({
	mockApi: [
		async ({ page }, use) => {
			let authenticated = false;
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));

			await page.route("**/api/**", async (route) => {
				const request = route.request();
				const path = new URL(request.url()).pathname;
				const method = request.method();
				if (!path.startsWith("/api/")) {
					await route.continue();
					return;
				}

				if (path === "/api/auth/login" && method === "POST") {
					authenticated = true;
					await route.fulfill({
						json: {
							ok: true,
							data: { authenticated: true, username: "admin", csrfToken: "e2e-csrf" },
						},
					});
					return;
				}

				if (path === "/api/auth/logout" && method === "POST") {
					authenticated = false;
					await route.fulfill({ json: { ok: true, data: { authenticated: false } } });
					return;
				}

				if (path === "/api/auth/session") {
					if (!authenticated) {
						await route.fulfill({
							status: 401,
							json: {
								ok: false,
								error: { code: "UNAUTHORIZED", message: "Sign in required" },
							},
						});
						return;
					}
					await route.fulfill({
						json: {
							ok: true,
							data: { authenticated: true, username: "admin", csrfToken: "e2e-csrf" },
						},
					});
					return;
				}

				if (!authenticated) {
					await route.fulfill({
						status: 401,
						json: {
							ok: false,
							error: { code: "UNAUTHORIZED", message: "Sign in required" },
						},
					});
					return;
				}

				if (path === "/api/overview") {
					await route.fulfill({
						json: {
							ok: true,
							data: {
								projectCount: 1,
								activeJobs: 1,
								queuedJobs: 0,
								attentionCount: 1,
								failedJobs: 0,
								prsAwaitingReview: 1,
								developmentMergedFeatures: 0,
								developmentMergedReleases: 0,
							},
						},
					});
					return;
				}

				if (path === "/api/attention") {
					await route.fulfill({
						json: {
							ok: true,
							data: {
								items: [
									{
										projectId: "project-1",
										releaseId: "release-1",
										featureId: "test-feature-1",
										category: "pr_review",
										reason: "PR awaiting review",
										state: "PR_REVIEW",
										ageBasis: NOW,
										primaryAction: "open_github_pr",
										prUrl: "https://github.com/example/repo/pull/42",
									},
								],
							},
						},
					});
					return;
				}

				if (path === "/api/activity") {
					await route.fulfill({
						json: {
							ok: true,
							data: {
								items: [
									{
										id: "event-1",
										type: "project.created",
										summary: "Project created",
										source: "e2e",
										occurredAt: NOW,
									},
								],
								nextCursor: null,
							},
						},
					});
					return;
				}

				if (path === "/api/releases") {
					await route.fulfill({
						json: {
							ok: true,
							data: [
								{
									id: "release-1",
									name: "Example release",
									version: "1.0.0",
									status: "active",
									projectId: "project-1",
								},
							],
						},
					});
					return;
				}

				if (path === "/api/projects") {
					await route.fulfill({
						json: {
							ok: true,
							data: [
								{
									id: "project-1",
									name: "Example project",
									slug: "example-project",
									status: "active",
									githubOwner: "example",
									githubRepo: "repo",
									developmentBranch: "main",
								},
							],
						},
					});
					return;
				}

				if (path === "/api/health") {
					const component = (name: string) => ({ name, status: "ok" });
					await route.fulfill({
						json: {
							ok: true,
							data: {
								status: "ok",
								database: component("database"),
								worker: component("worker"),
								github: component("github"),
								autopilot: component("autopilot"),
								checkedAt: NOW,
							},
						},
					});
					return;
				}

				if (/^\/api\/features\/[^/]+$/.test(path) && method === "GET") {
					await route.fulfill({
						json: {
							ok: true,
							data: {
								...FEATURE_DETAIL,
								id: path.split("/").at(-1),
							},
						},
					});
					return;
				}

				if (/^\/api\/projects\/[^/]+$/.test(path) && method === "GET") {
					await route.fulfill({
						json: {
							ok: true,
							data: {
								id: path.split("/").at(-1),
								name: "Example project",
								slug: "example-project",
								description: "Example",
								githubOwner: "example",
								githubRepo: "repo",
								developmentBranch: "main",
								canonicalPath: "/workspaces/example",
								status: "active",
								archivedAt: null,
								releases: [
									{
										id: "release-1",
										name: "Example release",
										version: "1.0.0",
										status: "active",
										archivedAt: null,
									},
								],
							},
						},
					});
					return;
				}

				if (/^\/api\/releases\/[^/]+$/.test(path) && method === "GET") {
					await route.fulfill({
						json: {
							ok: true,
							data: {
								id: path.split("/").at(-1),
								name: "Example release",
								version: "1.0.0",
								description: "Example release description",
								status: "active",
								projectId: "project-1",
								projectName: "Example project",
								archivedAt: null,
								developmentProgress: { total: 1, merged: 0 },
								features: [
									{
										id: "test-feature-1",
										title: "Example feature",
										slug: "example-feature",
										state: "DEVELOPING",
										branchName: "feature/example",
									},
								],
							},
						},
					});
					return;
				}

				if (path.endsWith("/cancel") || path.endsWith("/retry") || path.endsWith("/pr-retry")) {
					await route.fulfill({
						json: { ok: true, data: { accepted: true } },
					});
					return;
				}

				await route.fulfill({ json: { ok: true, data: {} } });
			});

			await use();
			expect(pageErrors).toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

export async function signIn(page: import("@playwright/test").Page) {
	await page.goto("/login");
	await page.fill("#username", "admin");
	await page.fill("#password", "password123");
	await page.click('button[type="submit"]');
	await page.waitForURL("**/");
}

export async function assertNoHorizontalOverflow(page: import("@playwright/test").Page) {
	const { bodyWidth, viewportWidth } = await page.evaluate(() => ({
		bodyWidth: document.body.scrollWidth,
		viewportWidth: window.innerWidth,
	}));
	expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);
}
