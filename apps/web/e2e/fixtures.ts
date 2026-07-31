import { test as base, expect } from "@playwright/test";

const NOW = "2026-07-19T12:00:00.000Z";

const REQUIREMENT_PASSED = {
	id: "1",
	description: "Bootstrap",
	status: "passed",
	passes: true,
	stuck: false,
	invalidTest: false,
	redPhase: true,
	greenPhase: true,
	refactorPhase: true,
	dependsOn: [] as string[],
	acceptance: ["Workspace boots"],
};

const REQUIREMENT_ACTIVE = {
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
};

const TASK_SUMMARY = {
	name: "Example task",
	description: "Task for e2e journeys",
	goals: ["Ship accessibility"],
	nonGoals: ["Rewrite engine"],
	requirements: [REQUIREMENT_PASSED, REQUIREMENT_ACTIVE],
	rawJson: JSON.stringify({ name: "Example task" }),
};

function baseFeature(overrides: Record<string, unknown> = {}) {
	return {
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
			requirementsSnapshot: { requirements: [REQUIREMENT_PASSED] },
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
			requirements: [REQUIREMENT_PASSED, REQUIREMENT_ACTIVE],
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
		...overrides,
	};
}

function createStore() {
	const projects = new Map<string, Record<string, unknown>>([
		[
			"project-1",
			{
				id: "project-1",
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
		],
	]);

	const releases = new Map<string, Record<string, unknown>>([
		[
			"release-1",
			{
				id: "release-1",
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
		],
	]);

	const features = new Map<string, Record<string, unknown>>([
		["test-feature-1", baseFeature()],
		[
			"test-feature-planned",
			baseFeature({
				id: "test-feature-planned",
				title: "Planned feature",
				slug: "planned-feature",
				state: "PLANNED",
				branchName: "feature/planned",
				taskPath: null,
				taskApproval: null,
				progress: null,
				activeAttempt: null,
				attempts: [],
				failures: [],
				diagnosticLogs: [],
				pullRequest: null,
				recentActivity: [],
			}),
		],
		[
			"test-feature-failed",
			baseFeature({
				id: "test-feature-failed",
				title: "Failed feature",
				slug: "failed-feature",
				state: "DEVELOPMENT_FAILED",
				branchName: "feature/failed",
				activeAttempt: null,
				attempts: [
					{
						id: "attempt-failed",
						status: "FAILED",
						workerRegistrationId: "worker-1",
						worker: {
							workerId: "worker-1",
							hostname: "dev",
							capacity: 4,
							activeJobs: 0,
							lastHeartbeatAt: NOW,
						},
						heartbeatAt: NOW,
						enqueuedAt: NOW,
						startedAt: NOW,
						endedAt: NOW,
						exitCode: 1,
						structuredResult: null,
						predecessorAttemptId: null,
					},
				],
				failures: [
					{
						id: "failure-failed",
						attemptId: "attempt-failed",
						category: "PROCESS_EXIT",
						summary: "Prior attempt exited with code 1",
						recommendedAction: "Review logs and retry",
						occurredAt: NOW,
					},
				],
				pullRequest: null,
			}),
		],
	]);

	let projectSeq = 2;
	let releaseSeq = 2;
	let featureSeq = 2;
	let attemptSeq = 2;

	return {
		projects,
		releases,
		features,
		nextProjectId() {
			return `project-${projectSeq++}`;
		},
		nextReleaseId() {
			return `release-${releaseSeq++}`;
		},
		nextFeatureId() {
			return `feature-${featureSeq++}`;
		},
		nextAttemptId() {
			return `attempt-${attemptSeq++}`;
		},
	};
}

type Store = ReturnType<typeof createStore>;

function json(data: unknown, status = 200) {
	return {
		status,
		contentType: "application/json",
		body: JSON.stringify(data),
	};
}

async function handleApi(
	store: Store,
	path: string,
	method: string,
	postData: string | null,
): Promise<ReturnType<typeof json> | null> {
	const body = postData ? (JSON.parse(postData) as Record<string, unknown>) : {};

	if (path === "/api/auth/login" && method === "POST") {
		return json({
			ok: true,
			data: { authenticated: true, username: "admin", csrfToken: "e2e-csrf" },
		});
	}

	if (path === "/api/auth/logout" && method === "POST") {
		return json({ ok: true, data: { authenticated: false } });
	}

	if (path === "/api/auth/session") {
		return json({
			ok: true,
			data: { authenticated: true, username: "admin", csrfToken: "e2e-csrf" },
		});
	}

	if (path === "/api/overview") {
		return json({
			ok: true,
			data: {
				projectCount: store.projects.size,
				activeJobs: 1,
				queuedJobs: 0,
				attentionCount: 1,
				failedJobs: 0,
				prsAwaitingReview: 1,
				developmentMergedFeatures: 0,
				developmentMergedReleases: 0,
			},
		});
	}

	if (path === "/api/attention") {
		return json({
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
		});
	}

	if (path === "/api/activity") {
		return json({
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
		});
	}

	if (path === "/api/releases" && method === "GET") {
		return json({
			ok: true,
			data: Array.from(store.releases.values()).map((release) => ({
				id: release.id,
				name: release.name,
				version: release.version,
				status: release.status,
				projectId: release.projectId,
			})),
		});
	}

	if (path === "/api/releases" && method === "POST") {
		const id = store.nextReleaseId();
		const projectId = String(body.projectId ?? "project-1");
		const project = store.projects.get(projectId);
		const release = {
			id,
			name: String(body.name ?? "Release"),
			version: String(body.version ?? "0.0.0"),
			description: String(body.description ?? ""),
			status: "active",
			projectId,
			projectName: String(project?.name ?? "Example project"),
			archivedAt: null,
			developmentProgress: { total: 0, merged: 0 },
			features: [] as Array<Record<string, unknown>>,
		};
		store.releases.set(id, release);
		const projectReleases = (project?.releases as Array<Record<string, unknown>> | undefined) ?? [];
		projectReleases.push({
			id,
			name: release.name,
			version: release.version,
			status: "active",
			archivedAt: null,
		});
		if (project) project.releases = projectReleases;
		return json({ ok: true, data: { id } });
	}

	if (path === "/api/projects" && method === "GET") {
		return json({
			ok: true,
			data: Array.from(store.projects.values()).map((project) => ({
				id: project.id,
				name: project.name,
				slug: project.slug,
				status: project.status,
				githubOwner: project.githubOwner,
				githubRepo: project.githubRepo,
				developmentBranch: project.developmentBranch,
			})),
		});
	}

	if (path === "/api/projects" && method === "POST") {
		const id = store.nextProjectId();
		const project = {
			id,
			name: String(body.name ?? "Project"),
			slug: String(body.slug ?? id),
			description: String(body.description ?? ""),
			githubOwner: String(body.githubOwner ?? "example"),
			githubRepo: String(body.githubRepo ?? "repo"),
			developmentBranch: String(body.developmentBranch ?? "main"),
			canonicalPath: String(body.workspacePath ?? body.canonicalPath ?? "/workspaces/example"),
			status: "active",
			archivedAt: null,
			releases: [] as Array<Record<string, unknown>>,
		};
		store.projects.set(id, project);
		return json({ ok: true, data: { id } });
	}

	if (path === "/api/projects/validate" && method === "POST") {
		const checks = [
			{ code: "path", ok: true, message: "Workspace path is valid" },
			{ code: "git", ok: true, message: "Git repository verified" },
			{ code: "branch", ok: true, message: "Development branch exists" },
			{ code: "autopilot", ok: true, message: "Autopilot executable available" },
			{ code: "gh", ok: true, message: "GitHub access verified" },
		];
		return json({
			ok: true,
			data: {
				ok: true,
				canonicalPath: String(body.workspacePath ?? "/workspaces/example"),
				checks,
			},
		});
	}

	if (path === "/api/health") {
		const component = (name: string) => ({ name, status: "ok" });
		return json({
			ok: true,
			data: {
				status: "ok",
				database: component("database"),
				worker: component("worker"),
				github: component("github"),
				autopilot: component("autopilot"),
				checkedAt: NOW,
			},
		});
	}

	if (path === "/api/features" && method === "POST") {
		const id = store.nextFeatureId();
		const feature = baseFeature({
			id,
			title: String(body.title ?? "Feature"),
			slug: String(body.slug ?? id),
			summary: String(body.summary ?? ""),
			state: "PLANNED",
			branchName: `feature/${String(body.slug ?? id)}`,
			projectId: String(body.projectId ?? "project-1"),
			releaseId: String(body.releaseId ?? "release-1"),
			taskPath: null,
			taskApproval: null,
			progress: null,
			activeAttempt: null,
			attempts: [],
			failures: [],
			diagnosticLogs: [],
			pullRequest: null,
			recentActivity: [],
		});
		store.features.set(id, feature);
		const release = store.releases.get(String(body.releaseId ?? "release-1"));
		if (release) {
			const list = (release.features as Array<Record<string, unknown>>) ?? [];
			list.push({
				id,
				title: feature.title,
				slug: feature.slug,
				state: feature.state,
				branchName: feature.branchName,
			});
			release.features = list;
		}
		return json({ ok: true, data: { id } });
	}

	const featureMatch = path.match(/^\/api\/features\/([^/]+)(.*)$/);
	if (featureMatch) {
		const featureId = featureMatch[1];
		const suffix = featureMatch[2] ?? "";
		const feature = store.features.get(featureId) ?? baseFeature({ id: featureId });
		if (!store.features.has(featureId)) store.features.set(featureId, feature);

		if (suffix === "" && method === "GET") {
			return json({ ok: true, data: feature });
		}

		if (suffix === "/task" && method === "POST") {
			const relativeTaskPath = String(
				body.relativeTaskPath ?? "docs/autopilotagent/example/example.json",
			);
			feature.taskPath = relativeTaskPath;
			feature.state = "TASKS_REVIEW";
			return json({
				ok: true,
				data: {
					feature: {
						id: feature.id,
						taskPath: relativeTaskPath,
						state: feature.state,
						rowVersion: Number(feature.rowVersion ?? 1) + 1,
					},
					summary: TASK_SUMMARY,
					checksum: "abc123",
				},
			});
		}

		if (suffix === "/task" && method === "PUT") {
			const relativeTaskPath = String(
				body.relativeTaskPath ?? "docs/autopilotagent/example/example.json",
			);
			feature.taskPath = relativeTaskPath;
			feature.state = "TASKS_REVIEW";
			feature.taskApproval = null;
			return json({
				ok: true,
				data: {
					feature: {
						id: feature.id,
						taskPath: relativeTaskPath,
						state: feature.state,
						taskApproval: null,
						rowVersion: Number(feature.rowVersion ?? 1) + 1,
					},
					summary: TASK_SUMMARY,
					checksum: "abc123",
				},
			});
		}

		if (suffix === "/task" && method === "DELETE") {
			feature.taskPath = null;
			feature.taskApproval = null;
			feature.state = "PLANNED";
			return json({
				ok: true,
				data: {
					id: feature.id,
					taskPath: null,
					taskApproval: null,
					state: feature.state,
				},
			});
		}

		if (suffix === "/approve-queue" && method === "POST") {
			const attemptId = store.nextAttemptId();
			feature.state = "DEVELOPING";
			feature.taskApproval = {
				id: "approval-live",
				relativeTaskPath: String(feature.taskPath ?? "docs/autopilotagent/example/example.json"),
				checksum: String(body.displayedChecksum ?? "abc123"),
				requirementsSnapshot: { requirements: TASK_SUMMARY.requirements },
				approvedAt: NOW,
			};
			feature.progress = {
				totalRequirements: 2,
				passedRequirements: 0,
				activeRequirements: 1,
				stuckRequirements: 0,
				invalidRequirements: 0,
				remainingRequirements: 2,
				activeRequirementId: "1",
				lastUpdatedAt: NOW,
				requirements: [REQUIREMENT_PASSED, REQUIREMENT_ACTIVE],
			};
			feature.activeAttempt = {
				id: attemptId,
				status: "QUEUED",
				workerRegistrationId: null,
				worker: null,
				heartbeatAt: null,
				enqueuedAt: NOW,
				startedAt: null,
				endedAt: null,
				exitCode: null,
				structuredResult: null,
				predecessorAttemptId: null,
			};
			feature.attempts = [feature.activeAttempt];
			return json({
				ok: true,
				data: {
					feature: {
						id: feature.id,
						state: feature.state,
						taskApproval: feature.taskApproval,
						progress: feature.progress,
						activeAttempt: feature.activeAttempt,
						attempts: feature.attempts,
						rowVersion: Number(feature.rowVersion ?? 1) + 1,
					},
				},
			});
		}

		if (suffix === "/cancel" && method === "POST") {
			feature.state = "DEVELOPMENT_CANCELLED";
			feature.activeAttempt = null;
			const attempts = (feature.attempts as Array<Record<string, unknown>>) ?? [];
			if (attempts[0]) {
				attempts[0] = {
					...attempts[0],
					status: "CANCELLED",
					endedAt: NOW,
				};
			}
			feature.attempts = attempts;
			return json({ ok: true, data: { accepted: true, feature } });
		}

		if (suffix === "/retry" && method === "POST") {
			const attemptId = store.nextAttemptId();
			const predecessor =
				((feature.attempts as Array<Record<string, unknown>>) ?? [])[0]?.id ?? null;
			feature.state = "DEVELOPING";
			feature.activeAttempt = {
				id: attemptId,
				status: "QUEUED",
				workerRegistrationId: null,
				worker: null,
				heartbeatAt: null,
				enqueuedAt: NOW,
				startedAt: null,
				endedAt: null,
				exitCode: null,
				structuredResult: null,
				predecessorAttemptId: predecessor,
			};
			feature.attempts = [
				feature.activeAttempt,
				...((feature.attempts as Array<Record<string, unknown>>) ?? []),
			];
			return json({ ok: true, data: { accepted: true, feature } });
		}

		if (suffix === "/pr-retry" && method === "POST") {
			feature.state = "PR_OPEN";
			feature.pullRequest = {
				number: 42,
				url: "https://github.com/example/repo/pull/42",
				observedState: "OPEN",
				observedHeadSha: "deadbeef",
				mergeCommitSha: null,
				lastObservedAt: NOW,
			};
			return json({ ok: true, data: { accepted: true, feature } });
		}

		const invalidateMatch = suffix.match(/^\/approvals\/([^/]+)\/invalidate$/);
		if (invalidateMatch && method === "POST") {
			feature.taskApproval = null;
			feature.state = "TASKS_REVIEW";
			return json({ ok: true, data: { accepted: true } });
		}
	}

	const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
	if (projectMatch && method === "GET") {
		const project = store.projects.get(projectMatch[1]);
		if (!project) {
			return json({ ok: false, error: { code: "NOT_FOUND", message: "Project not found" } }, 404);
		}
		return json({ ok: true, data: project });
	}

	const releaseMatch = path.match(/^\/api\/releases\/([^/]+)$/);
	if (releaseMatch && method === "GET") {
		const release = store.releases.get(releaseMatch[1]);
		if (!release) {
			return json({ ok: false, error: { code: "NOT_FOUND", message: "Release not found" } }, 404);
		}
		return json({ ok: true, data: release });
	}

	return json({ ok: true, data: {} });
}

export const test = base.extend<{ mockApi: undefined }>({
	mockApi: [
		async ({ page }, use) => {
			const store = createStore();
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
				}
				if (path === "/api/auth/logout" && method === "POST") {
					authenticated = false;
				}

				if (path === "/api/auth/session" && !authenticated) {
					await route.fulfill(
						json(
							{
								ok: false,
								error: { code: "UNAUTHORIZED", message: "Sign in required" },
							},
							401,
						),
					);
					return;
				}

				if (
					!authenticated &&
					path !== "/api/auth/login" &&
					path !== "/api/auth/session" &&
					path !== "/api/auth/logout"
				) {
					await route.fulfill(
						json(
							{
								ok: false,
								error: { code: "UNAUTHORIZED", message: "Sign in required" },
							},
							401,
						),
					);
					return;
				}

				const response = await handleApi(store, path, method, request.postData());
				if (!response) {
					await route.fulfill(json({ ok: true, data: {} }));
					return;
				}
				await route.fulfill(response);
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

export async function assertPrimaryTapTargets(page: import("@playwright/test").Page) {
	await expect(page.locator("main")).toBeVisible();
	const boxes = await page.evaluate(() => {
		const nodes = Array.from(document.querySelectorAll("button, a[href]")).filter((el) => {
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return (
				style.display !== "none" &&
				style.visibility !== "hidden" &&
				rect.width > 0 &&
				rect.height > 0
			);
		});
		return nodes.slice(0, 24).map((el) => {
			const rect = el.getBoundingClientRect();
			return {
				width: rect.width,
				height: rect.height,
				label: (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40),
			};
		});
	});
	expect(boxes.length).toBeGreaterThan(0);
	for (const box of boxes) {
		expect(box.width, `width for ${box.label}`).toBeGreaterThanOrEqual(44);
		expect(box.height, `height for ${box.label}`).toBeGreaterThanOrEqual(44);
	}
}

export async function assertNoConsolePrApproveOrMerge(page: import("@playwright/test").Page) {
	await expect(
		page.getByRole("button", { name: /approve pr|merge pr|merge pull request|^merge$/i }),
	).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: /approve pr|merge pr|merge pull request/i }),
	).toHaveCount(0);
}

export async function assertVisibleFocus(locator: import("@playwright/test").Locator) {
	await expect(locator).toBeFocused();
	const outline = await locator.evaluate((node) => {
		const style = window.getComputedStyle(node);
		return {
			outlineStyle: style.outlineStyle,
			outlineWidth: style.outlineWidth,
			boxShadow: style.boxShadow,
		};
	});
	const hasFocusIndicator =
		(outline.outlineStyle !== "none" && outline.outlineWidth !== "0px") ||
		(outline.boxShadow !== "none" && outline.boxShadow !== "");
	expect(hasFocusIndicator).toBe(true);
}

export async function assertWcag22Aa(page: import("@playwright/test").Page, route: string) {
	const AxeBuilder = (await import("@axe-core/playwright")).default;
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag22aa"])
		.analyze();
	const knownRules = new Set([
		...results.passes.map((entry) => entry.id),
		...results.violations.map((entry) => entry.id),
		...results.inapplicable.map((entry) => entry.id),
		...results.incomplete.map((entry) => entry.id),
	]);
	expect(knownRules.has("color-contrast"), `color-contrast rule missing on ${route}`).toBe(true);
	const serious = results.violations.filter(
		(violation) => violation.impact === "serious" || violation.impact === "critical",
	);
	expect(serious, `WCAG violations on ${route}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
}
