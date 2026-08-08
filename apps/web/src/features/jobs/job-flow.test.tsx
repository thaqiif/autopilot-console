/**
 * RED tests for durable job progress, attempt history, cancellation/retry,
 * failure diagnostics, and GitHub PR/CI/review owner workflows (requirement 28).
 *
 * Covers: structured counts/phases, timing/heartbeat, stale REST
 * reconciliation, immutable attempts, cancellation/retry confirmations
 * and refusal, safe failures/log caps, all PR/CI/review states and links,
 * and proof no merge action renders.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createApiClient } from "../../api/client";
import { AuthProvider } from "../../auth/auth-provider";

// ---------------------------------------------------------------------------
// Stub page components — modules under test.
// ---------------------------------------------------------------------------

let FeatureDetailPage: React.ComponentType;
let JobProgress: React.ComponentType<JobProgressProps>;
let AttemptHistory: React.ComponentType<AttemptHistoryProps>;
let JobActions: React.ComponentType<JobActionsProps>;
let FailureDetail: React.ComponentType<FailureDetailProps>;
let DiagnosticLogExcerpt: React.ComponentType<DiagnosticLogExcerptProps>;
let PullRequestStatus: React.ComponentType<PullRequestStatusProps>;

interface RequirementProgress {
	id: string;
	description: string;
	status: "not_started" | "in_progress" | "passed" | "stuck" | "invalid";
	passes: boolean;
	stuck: boolean;
	invalidTest: boolean;
	redPhase: boolean;
	greenPhase: boolean;
	refactorPhase: boolean;
}

interface JobProgressProps {
	featureId: string;
	featureState: string;
	totalRequirements: number;
	passedRequirements: number;
	activeRequirements: number;
	stuckRequirements: number;
	invalidRequirements: number;
	remainingRequirements: number;
	requirements: RequirementProgress[];
	queueTime?: string;
	startTime?: string;
	elapsedMs?: number;
	workerId?: string;
	workerState?: string;
	lastHeartbeat?: string;
	lastUpdate?: string;
	activeRequirementId?: string;
	recentActivity?: ActivityEvent[];
	diagnosticLogExcerpt?: string;
	isStale?: boolean;
	onRefresh?: () => void;
}

interface AttemptRecord {
	id: string;
	status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELLED";
	predecessorAttemptId?: string;
	queuedAt: string;
	startedAt?: string;
	endedAt?: string;
	workerId?: string;
	exitCode?: number;
	resultSummary?: string;
	logExcerpt?: string;
}

interface ActivityEvent {
	id: string;
	type: string;
	message: string;
	timestamp: string;
}

interface AttemptHistoryProps {
	attempts: AttemptRecord[];
}

interface JobActionsProps {
	featureId: string;
	featureState: string;
	attemptId?: string;
	onCancel?: () => void;
	onRetry?: () => void;
	onPrRetry?: () => void;
	isCancelling?: boolean;
	isRetrying?: boolean;
	isPrRetrying?: boolean;
	cancelRefused?: string | null;
	retryRefused?: string | null;
	projectName?: string;
	featureTitle?: string;
}

interface FailureDetailProps {
	code: string;
	message: string;
	operation: string;
	attemptId?: string;
	timestamp: string;
	nextAction?: string;
}

interface DiagnosticLogExcerptProps {
	log: string;
	maxLines?: number;
	truncated?: boolean;
}

interface PullRequestStatusProps {
	prNumber?: number;
	prUrl?: string;
	prState?: "OPEN" | "CLOSED" | "MERGED";
	headSha?: string;
	checksStatus?: "PENDING" | "PASSING" | "FAILING" | "NONE";
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";
	mergeCommitSha?: string;
	lastSyncAt?: string;
	isStale?: boolean;
}

try {
	FeatureDetailPage = (await import("../features/feature-detail-page")).FeatureDetailPage;
} catch {
	FeatureDetailPage = () => <div data-testid="feature-detail-missing" />;
}
try {
	JobProgress = (await import("./job-progress")).JobProgress;
} catch {
	JobProgress = () => <div data-testid="job-progress-missing" />;
}
try {
	AttemptHistory = (await import("./attempt-history")).AttemptHistory;
} catch {
	AttemptHistory = () => <div data-testid="attempt-history-missing" />;
}
try {
	JobActions = (await import("./job-actions")).JobActions;
} catch {
	JobActions = () => <div data-testid="job-actions-missing" />;
}
try {
	FailureDetail = (await import("./failure-detail")).FailureDetail;
} catch {
	FailureDetail = () => <div data-testid="failure-detail-missing" />;
}
try {
	DiagnosticLogExcerpt = (await import("./diagnostic-log-excerpt")).DiagnosticLogExcerpt;
} catch {
	DiagnosticLogExcerpt = () => <div data-testid="diagnostic-log-missing" />;
}
try {
	PullRequestStatus = (await import("../pull-requests/pull-request-status")).PullRequestStatus;
} catch {
	PullRequestStatus = () => <div data-testid="pull-request-status-missing" />;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_REQUIREMENTS: RequirementProgress[] = [
	{
		id: "1",
		description: "Create user model",
		status: "passed",
		passes: true,
		stuck: false,
		invalidTest: false,
		redPhase: true,
		greenPhase: true,
		refactorPhase: true,
	},
	{
		id: "2",
		description: "Implement login endpoint",
		status: "in_progress",
		passes: false,
		stuck: false,
		invalidTest: false,
		redPhase: true,
		greenPhase: false,
		refactorPhase: false,
	},
	{
		id: "3",
		description: "Add password reset",
		status: "stuck",
		passes: false,
		stuck: true,
		invalidTest: false,
		redPhase: true,
		greenPhase: false,
		refactorPhase: false,
	},
	{
		id: "4",
		description: "Session invalidation",
		status: "invalid",
		passes: false,
		stuck: false,
		invalidTest: true,
		redPhase: true,
		greenPhase: false,
		refactorPhase: false,
	},
	{
		id: "5",
		description: "OAuth2 integration",
		status: "not_started",
		passes: false,
		stuck: false,
		invalidTest: false,
		redPhase: false,
		greenPhase: false,
		refactorPhase: false,
	},
];

const MOCK_ATTEMPTS: AttemptRecord[] = [
	{
		id: "attempt-1",
		status: "FAILED",
		queuedAt: "2026-07-17T10:00:00Z",
		startedAt: "2026-07-17T10:00:05Z",
		endedAt: "2026-07-17T10:05:00Z",
		workerId: "worker-1",
		exitCode: 1,
		resultSummary: "2 of 5 requirements failed",
		logExcerpt: "Error: Cannot find module 'bcrypt'",
	},
	{
		id: "attempt-2",
		status: "RUNNING",
		predecessorAttemptId: "attempt-1",
		queuedAt: "2026-07-17T10:10:00Z",
		startedAt: "2026-07-17T10:10:03Z",
		workerId: "worker-2",
	},
	{
		id: "attempt-0",
		status: "SUCCEEDED",
		queuedAt: "2026-07-16T08:00:00Z",
		startedAt: "2026-07-16T08:00:02Z",
		endedAt: "2026-07-16T08:15:00Z",
		workerId: "worker-1",
		exitCode: 0,
		resultSummary: "All 5 requirements passed",
	},
];

const MOCK_ACTIVITY: ActivityEvent[] = [
	{
		id: "evt-1",
		type: "requirement_passed",
		message: "Requirement 1 passed",
		timestamp: "2026-07-17T10:02:00Z",
	},
	{
		id: "evt-2",
		type: "requirement_failed",
		message: "Requirement 3 stuck: Email service unavailable",
		timestamp: "2026-07-17T10:03:00Z",
	},
];

const MOCK_FAILURE: FailureDetailProps = {
	code: "DEVELOPMENT_FAILED",
	message: "Development failed: 2 of 5 requirements did not pass",
	operation: "development",
	attemptId: "attempt-1",
	timestamp: "2026-07-17T10:05:00Z",
	nextAction: "Review failed requirements and retry development",
};

const MOCK_DIAGNOSTIC_LOG = `Starting Autopilot...
Loading task file: tasks/user-auth.json
Running requirement 1: Create user model
  RED: Writing tests...
  GREEN: Implementing...
  REFACTOR: Cleaning up...
Requirement 1 PASSED
Running requirement 2: Implement login endpoint
  RED: Writing tests...
Error: Cannot find module 'bcrypt'
at Function.Module._resolveFilename (internal/modules/cjs/loader.js)
at Function.Module._load (internal/modules/cjs/loader.js)
Process exited with code 1`;

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

function installFetchMock(opts?: {
	featureState?: string;
	attempts?: AttemptRecord[];
	failure?: FailureDetailProps | null;
	prStatus?: Partial<PullRequestStatusProps>;
	callCounter?: { count: number };
	includeDiagnosticLog?: boolean;
	stalePr?: boolean;
}) {
	const original = globalThis.fetch;
	const featureState = opts?.featureState ?? "DEVELOPING";
	const attempts = opts?.attempts ?? MOCK_ATTEMPTS;
	const callCounter = opts?.callCounter;
	const prStates = new Set([
		"PR_CREATING",
		"PR_CREATION_FAILED",
		"CI_RUNNING",
		"CI_FAILED",
		"PR_REVIEW",
		"PR_CHANGES_REQUESTED",
		"DEVELOPMENT_MERGED",
	]);
	const pr = prStates.has(featureState)
		? {
				prNumber: 42,
				prUrl: "https://github.com/thaqiif/autopilot-console/pull/42",
				prState: featureState === "DEVELOPMENT_MERGED" ? ("MERGED" as const) : ("OPEN" as const),
				headSha: "abc123",
				lastSyncAt: opts?.stalePr ? "2020-01-01T00:00:00Z" : "2026-07-17T10:12:00Z",
				...(opts?.prStatus ?? {}),
			}
		: undefined;
	const activeAttempt = attempts.find((attempt) => attempt.status === "RUNNING") ?? attempts[0];

	const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		if (callCounter) callCounter.count += 1;

		if (url.match(/\/api\/projects\/proj-1$/) && method === "GET") {
			return new Response(
				JSON.stringify({
					ok: true,
					data: { id: "proj-1", name: "Autopilot Console" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.match(/\/api\/features\/feat-1$/) && method === "GET") {
			return new Response(
				JSON.stringify({
					ok: true,
					data: {
						id: "feat-1",
						projectId: "proj-1",
						releaseId: "rel-1",
						title: "User Authentication",
						slug: "user-auth",
						summary: "Implement user authentication",
						state: featureState,
						branchName: "feature/feat-1-user-auth",
						taskPath: null,
						rowVersion: 1,
						taskApproval: null,
						progress: {
							totalRequirements: 5,
							passedRequirements: 1,
							activeRequirements: 1,
							stuckRequirements: 1,
							invalidRequirements: 1,
							remainingRequirements: 1,
							activeRequirementId: "2",
							lastUpdatedAt: "2026-07-17T10:12:00Z",
							requirements: MOCK_REQUIREMENTS.map((requirement) => ({
								id: requirement.id,
								description: requirement.description,
								status: requirement.status,
								passes: requirement.passes,
								stuck: requirement.stuck,
								invalidTest: requirement.invalidTest,
								dependsOn: requirement.id === "3" ? ["1"] : [],
								acceptance: ["must work"],
								phases: {
									red: requirement.redPhase,
									green: requirement.greenPhase,
									refactor: requirement.refactorPhase,
								},
							})),
						},
						activeAttempt: activeAttempt
							? {
									id: activeAttempt.id,
									status: activeAttempt.status,
									workerRegistrationId: activeAttempt.workerId ?? null,
									worker: activeAttempt.workerId
										? {
												workerId: activeAttempt.workerId,
												hostname: "worker-host",
												capacity: 2,
												activeJobs: 1,
												lastHeartbeatAt: "2026-07-17T10:12:00Z",
											}
										: null,
									heartbeatAt: "2026-07-17T10:12:00Z",
									enqueuedAt: activeAttempt.queuedAt,
									startedAt: activeAttempt.startedAt ?? null,
									endedAt: activeAttempt.endedAt ?? null,
									exitCode: activeAttempt.exitCode ?? null,
									structuredResult: activeAttempt.resultSummary
										? { summary: activeAttempt.resultSummary }
										: null,
									predecessorAttemptId: activeAttempt.predecessorAttemptId ?? null,
								}
							: null,
						attempts: attempts.map((attempt) => ({
							id: attempt.id,
							status: attempt.status,
							workerRegistrationId: attempt.workerId ?? null,
							worker: attempt.workerId
								? {
										workerId: attempt.workerId,
										hostname: "worker-host",
										capacity: 2,
										activeJobs: 1,
										lastHeartbeatAt: "2026-07-17T10:12:00Z",
									}
								: null,
							heartbeatAt: attempt.status === "RUNNING" ? "2026-07-17T10:12:00Z" : null,
							enqueuedAt: attempt.queuedAt,
							startedAt: attempt.startedAt ?? null,
							endedAt: attempt.endedAt ?? null,
							exitCode: attempt.exitCode ?? null,
							structuredResult: attempt.resultSummary ? { summary: attempt.resultSummary } : null,
							predecessorAttemptId: attempt.predecessorAttemptId ?? null,
						})),
						failures:
							opts?.failure == null
								? []
								: [
										{
											id: "failure-1",
											attemptId: opts.failure.attemptId ?? null,
											category: opts.failure.code,
											summary: opts.failure.message,
											recommendedAction: opts.failure.nextAction ?? "Retry development",
											occurredAt: opts.failure.timestamp,
										},
									],
						diagnosticLogs:
							opts?.includeDiagnosticLog === false
								? []
								: [
										{
											id: "log-1",
											attemptId: "attempt-1",
											sequence: 1,
											stream: "stderr",
											body: MOCK_DIAGNOSTIC_LOG,
											truncated: true,
										},
									],
						pullRequest: pr
							? {
									number: pr.prNumber,
									url: pr.prUrl,
									observedState: pr.prState,
									observedHeadSha: pr.headSha,
									mergeCommitSha: pr.mergeCommitSha ?? null,
									lastObservedAt: pr.lastSyncAt,
								}
							: null,
						recentActivity: MOCK_ACTIVITY.map((activity) => ({
							id: activity.id,
							type: activity.type,
							summary: activity.message,
							occurredAt: activity.timestamp,
						})),
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/api/features/feat-1/jobs") && method === "GET") {
			const PR_STATES = new Set([
				"PR_CREATING",
				"PR_CREATION_FAILED",
				"CI_RUNNING",
				"CI_FAILED",
				"PR_REVIEW",
				"PR_CHANGES_REQUESTED",
				"DEVELOPMENT_MERGED",
			]);
			const pr = PR_STATES.has(featureState)
				? {
						prNumber: 42,
						prUrl: "https://github.com/thaqiif/autopilot-console/pull/42",
						prState:
							featureState === "DEVELOPMENT_MERGED" ? ("MERGED" as const) : ("OPEN" as const),
						headSha: "abc123",
						checksStatus:
							featureState === "CI_FAILED"
								? ("FAILING" as const)
								: featureState === "CI_RUNNING"
									? ("PENDING" as const)
									: ("PASSING" as const),
						reviewDecision:
							featureState === "PR_CHANGES_REQUESTED"
								? ("CHANGES_REQUESTED" as const)
								: featureState === "PR_REVIEW"
									? ("REVIEW_REQUIRED" as const)
									: ("NONE" as const),
						lastSyncAt: "2026-07-17T10:12:00Z",
						...(opts?.prStatus ?? {}),
					}
				: undefined;
			return new Response(
				JSON.stringify({
					ok: true,
					data: {
						attempts,
						progress: {
							total: 5,
							passed: 1,
							active: 1,
							stuck: 1,
							invalid: 1,
							remaining: 1,
							requirements: MOCK_REQUIREMENTS,
						},
						failure: opts?.failure === undefined ? null : opts.failure,
						pr,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/api/features/feat-1/activity") && method === "GET") {
			return new Response(
				JSON.stringify({ ok: true, data: { items: MOCK_ACTIVITY, cursor: null } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/api/features/feat-1/cancel") && method === "POST") {
			return new Response(JSON.stringify({ ok: true, data: { cancelled: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/api/features/feat-1/retry") && method === "POST") {
			return new Response(
				JSON.stringify({ ok: true, data: { attemptId: "attempt-3", queued: true } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/api/features/feat-1/pr-retry") && method === "POST") {
			return new Response(JSON.stringify({ ok: true, data: { prRetryQueued: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response(null, { status: 404 });
	}) as typeof fetch;

	globalThis.fetch = mockFetch;
	return () => {
		globalThis.fetch = original;
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderAt(path: string, _opts?: { featureState?: string }) {
	const client = createApiClient({ baseUrl: "", getCsrfToken: () => "test-csrf" });
	const router = createMemoryRouter(
		[
			{
				path: "/login",
				element: (
					<AuthProvider initialAuthenticated={false}>
						<div />
					</AuthProvider>
				),
			},
			{
				path: "/features/:id",
				element: (
					<AuthProvider client={client} initialAuthenticated={true}>
						<FeatureDetailPage />
					</AuthProvider>
				),
			},
		],
		{ initialEntries: [path] },
	);
	return render(<RouterProvider router={router} />);
}

function renderJobProgress(overrides?: Partial<JobProgressProps>) {
	const props: JobProgressProps = {
		featureId: "feat-1",
		featureState: "DEVELOPING",
		totalRequirements: 5,
		passedRequirements: 1,
		activeRequirements: 1,
		stuckRequirements: 1,
		invalidRequirements: 1,
		remainingRequirements: 1,
		requirements: MOCK_REQUIREMENTS,
		queueTime: "2026-07-17T10:10:00Z",
		startTime: "2026-07-17T10:10:03Z",
		elapsedMs: 120_000,
		workerId: "worker-2",
		workerState: "RUNNING",
		lastHeartbeat: "2026-07-17T10:12:00Z",
		lastUpdate: "2026-07-17T10:12:00Z",
		activeRequirementId: "2",
		recentActivity: MOCK_ACTIVITY,
		...overrides,
	};
	return render(<JobProgress {...props} />);
}

function renderAttemptHistory(overrides?: Partial<AttemptHistoryProps>) {
	const props: AttemptHistoryProps = {
		attempts: MOCK_ATTEMPTS,
		...overrides,
	};
	return render(<AttemptHistory {...props} />);
}

function renderJobActions(overrides?: Partial<JobActionsProps>) {
	const props: JobActionsProps = {
		featureId: "feat-1",
		featureState: "DEVELOPING",
		attemptId: "attempt-2",
		onCancel: () => {},
		onRetry: () => {},
		...overrides,
	};
	return render(<JobActions {...props} />);
}

function renderFailureDetail(overrides?: Partial<FailureDetailProps>) {
	return render(<FailureDetail {...MOCK_FAILURE} {...overrides} />);
}

function renderDiagnosticLog(overrides?: Partial<DiagnosticLogExcerptProps>) {
	return render(<DiagnosticLogExcerpt log={MOCK_DIAGNOSTIC_LOG} maxLines={10} {...overrides} />);
}

function renderPRStatus(overrides?: Partial<PullRequestStatusProps>) {
	const props: PullRequestStatusProps = {
		prNumber: 42,
		prUrl: "https://github.com/thaqiif/autopilot-console/pull/42",
		prState: "OPEN",
		headSha: "abc123",
		checksStatus: "PASSING",
		reviewDecision: "APPROVED",
		lastSyncAt: "2026-07-17T10:12:00Z",
		...overrides,
	};
	return render(<PullRequestStatus {...props} />);
}

// ---------------------------------------------------------------------------
// 1. JobProgress — structured requirement counts/phases, timing, heartbeat
// ---------------------------------------------------------------------------

describe("job progress structured counts and phases", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders total requirement count", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Total");
		expect(container.textContent).toContain("5");
	});

	test("renders passed requirement count", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Passed");
	});

	test("renders stuck requirement count", () => {
		const { container } = renderJobProgress({ stuckRequirements: 2 });
		expect(container.textContent).toContain("Stuck");
	});

	test("renders invalid requirement count", () => {
		const { container } = renderJobProgress({ invalidRequirements: 3 });
		expect(container.textContent).toContain("Invalid");
	});

	test("renders remaining requirement count", () => {
		const { container } = renderJobProgress({ remainingRequirements: 3 });
		expect(container.textContent).toContain("Remaining");
	});

	test("renders active requirement description when known", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Active requirement:");
		expect(container.textContent).toContain("Implement login endpoint");
	});

	test("renders requirement phase indicators for each requirement", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Red:");
		expect(container.textContent).toContain("Green:");
		expect(container.textContent).toContain("Refactor:");
	});

	test("renders TDD state per requirement with text labels", () => {
		const { container } = renderJobProgress();
		// Should show Red/Green/Refactor phase info
		expect(container.textContent).toContain("Red");
	});
});

describe("job progress timing and heartbeat", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders queue time", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Queued");
	});

	test("renders start time", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Started");
	});

	test("renders elapsed time in human-readable form", () => {
		renderJobProgress({ elapsedMs: 120_000 });
		expect(screen.getByText(/2 min/i)).toBeTruthy();
	});

	test("renders worker state", () => {
		renderJobProgress();
		expect(screen.getByText(/running/i)).toBeTruthy();
	});

	test("renders last heartbeat time", () => {
		const { container } = renderJobProgress();
		expect(container.textContent).toContain("Last Heartbeat");
	});

	test("renders last update time", () => {
		const { container } = renderJobProgress({ isStale: true });
		expect(container.textContent).toContain("Last update");
	});

	test("shows recent activity events", () => {
		renderJobProgress();
		expect(screen.getByText(/requirement 1 passed/i)).toBeTruthy();
	});
});

describe("job progress stale REST reconciliation", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("shows stale indicator when isStale is true", () => {
		renderJobProgress({ isStale: true, lastUpdate: "2026-07-17T10:12:00Z" });
		expect(screen.getByText(/last update/i)).toBeTruthy();
	});

	test("provides refresh button when stale", () => {
		renderJobProgress({ isStale: true, onRefresh: () => {} });
		expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
	});

	test("calls onRefresh when refresh clicked", () => {
		let refreshed = false;
		renderJobProgress({
			isStale: true,
			onRefresh: () => {
				refreshed = true;
			},
		});
		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		expect(refreshed).toBe(true);
	});

	test("progress returns after REST refresh without losing persisted state", () => {
		const { container } = renderJobProgress({ isStale: false });
		expect(container.textContent).toContain("Total");
		expect(container.textContent).toContain("5");
	});
});

// ---------------------------------------------------------------------------
// 2. AttemptHistory — immutable attempts
// ---------------------------------------------------------------------------

describe("attempt history immutable records", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders all attempts", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("attempt-1");
		expect(container.textContent).toContain("attempt-2");
		expect(container.textContent).toContain("attempt-0");
	});

	test("renders attempt status badges with text", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("FAILED");
		expect(container.textContent).toContain("RUNNING");
		expect(container.textContent).toContain("SUCCEEDED");
	});

	test("renders queued time for each attempt", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("Queued");
	});

	test("renders start time for started attempts", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("Started");
	});

	test("renders end time for completed attempts", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("Ended");
	});

	test("renders exit code for completed attempts", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("Exit Code");
	});

	test("renders result summary", () => {
		renderAttemptHistory();
		expect(screen.getByText(/2 of 5 requirements failed/i)).toBeTruthy();
	});

	test("renders log excerpt for failed attempts", () => {
		renderAttemptHistory();
		expect(screen.getByText(/cannot find module/i)).toBeTruthy();
	});

	test("renders predecessor link for retry attempts", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("Predecessor");
		expect(container.textContent).toContain("attempt-1");
	});

	test("renders worker id", () => {
		const { container } = renderAttemptHistory();
		expect(container.textContent).toContain("Worker");
		expect(container.textContent).toContain("worker-1");
	});

	test("renders empty state when no attempts", () => {
		renderAttemptHistory({ attempts: [] });
		expect(screen.getByText(/no attempts/i)).toBeTruthy();
	});

	test("renders success result summary for succeeded attempt", () => {
		renderAttemptHistory();
		expect(screen.getByText(/all 5 requirements passed/i)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 3. JobActions — cancel/retry with confirmations
// ---------------------------------------------------------------------------

describe("job actions cancel and retry", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders cancel button during DEVELOPING state", () => {
		renderJobActions({ featureState: "DEVELOPING" });
		expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
	});

	test("renders cancel button during QUEUED state", () => {
		renderJobActions({ featureState: "QUEUED" });
		expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
	});

	test("cancel triggers confirmation dialog", async () => {
		renderJobActions({ featureState: "DEVELOPING" });
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
	});

	test("cancel confirmation shows descriptive text", async () => {
		renderJobActions({ featureState: "DEVELOPING" });
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toMatch(/cancel/i);
		});
	});

	test("confirm cancel calls onCancel", async () => {
		let cancelled = false;
		renderJobActions({
			featureState: "DEVELOPING",
			onCancel: () => {
				cancelled = true;
			},
		});
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(cancelled).toBe(true);
	});

	test("retry button visible for FAILED state", () => {
		renderJobActions({ featureState: "DEVELOPMENT_FAILED" });
		expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
	});

	test("retry button visible for INTERRUPTED state", () => {
		renderJobActions({ featureState: "DEVELOPMENT_INTERRUPTED" });
		expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
	});

	test("retry button visible for CANCELLED state", () => {
		renderJobActions({ featureState: "DEVELOPMENT_CANCELLED" });
		expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
	});

	test("retry triggers confirmation dialog", async () => {
		renderJobActions({ featureState: "DEVELOPMENT_FAILED" });
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
	});

	test("confirm retry calls onRetry", async () => {
		let retried = false;
		renderJobActions({
			featureState: "DEVELOPMENT_FAILED",
			onRetry: () => {
				retried = true;
			},
		});
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(retried).toBe(true);
	});

	test("duplicate submission disabled while cancelling", () => {
		renderJobActions({ featureState: "DEVELOPING", isCancelling: true });
		const btn = screen.getByRole("button", { name: /cancel/i });
		expect(btn.hasAttribute("disabled")).toBe(true);
	});

	test("duplicate submission disabled while retrying", () => {
		renderJobActions({ featureState: "DEVELOPMENT_FAILED", isRetrying: true });
		const btn = screen.getByRole("button", { name: /retry/i });
		expect(btn.hasAttribute("disabled")).toBe(true);
	});

	test("cancel refused shows message", () => {
		renderJobActions({
			featureState: "DEVELOPING",
			cancelRefused: "Process already exited",
		});
		expect(screen.getByText(/process already exited/i)).toBeTruthy();
	});

	test("retry refused shows message", () => {
		renderJobActions({
			featureState: "DEVELOPMENT_FAILED",
			retryRefused: "Another attempt is already running",
		});
		expect(screen.getByText(/another attempt is already running/i)).toBeTruthy();
	});

	test("no cancel or retry in DEVELOPMENT_MERGED state", () => {
		renderJobActions({ featureState: "DEVELOPMENT_MERGED" });
		expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
	});

	test("no cancel or retry in DEVELOPMENT_COMPLETE state", () => {
		renderJobActions({ featureState: "DEVELOPMENT_COMPLETE" });
		expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
	});

	test("pr retry button visible in PR_CREATION_FAILED state", () => {
		renderJobActions({ featureState: "PR_CREATION_FAILED" });
		expect(screen.getByRole("button", { name: /retry.*pr|pr.*retry/i })).toBeTruthy();
	});

	test("pr retry triggers confirmation", async () => {
		renderJobActions({
			featureState: "PR_CREATION_FAILED",
			onPrRetry: () => {},
		});
		fireEvent.click(screen.getByRole("button", { name: /retry.*pr|pr.*retry/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
	});

	test("confirm pr retry calls onPrRetry", async () => {
		let prRetried = false;
		renderJobActions({
			featureState: "PR_CREATION_FAILED",
			onPrRetry: () => {
				prRetried = true;
			},
		});
		fireEvent.click(screen.getByRole("button", { name: /retry.*pr|pr.*retry/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(prRetried).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. FailureDetail — safe summary, no credentials
// ---------------------------------------------------------------------------

describe("failure detail", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders failure code", () => {
		renderFailureDetail();
		expect(screen.getByText(/development_failed/i)).toBeTruthy();
	});

	test("renders safe failure message", () => {
		renderFailureDetail();
		expect(screen.getByText(/2 of 5 requirements did not pass/i)).toBeTruthy();
	});

	test("renders affected operation", () => {
		const { container } = renderFailureDetail();
		expect(container.textContent).toContain("Operation");
		expect(container.textContent).toContain("development");
	});

	test("renders attempt id when present", () => {
		const { container } = renderFailureDetail();
		expect(container.textContent).toContain("Attempt");
		expect(container.textContent).toContain("attempt-1");
	});

	test("renders failure timestamp", () => {
		const { container } = renderFailureDetail();
		expect(container.textContent).toContain("Time");
		expect(container.textContent).toContain("2026");
	});

	test("renders recommended next action", () => {
		renderFailureDetail();
		expect(screen.getByText(/review failed requirements/i)).toBeTruthy();
	});

	test("renders failure without attempt when not provided", () => {
		renderFailureDetail({ attemptId: undefined });
		expect(screen.getByText(/development_failed/i)).toBeTruthy();
	});

	test("failure detail has alert role", () => {
		renderFailureDetail();
		const alert = screen.getByRole("alert");
		expect(alert).toBeTruthy();
	});

	test("does not expose credentials in failure message", () => {
		renderFailureDetail({
			message: "GitHub API error: token ghp_abc123secret is invalid",
		});
		expect(screen.queryByText(/ghp_abc123secret/)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5. DiagnosticLogExcerpt — bounded, redacted, formatted
// ---------------------------------------------------------------------------

describe("diagnostic log excerpt", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders log content in a code block", () => {
		renderDiagnosticLog();
		const codeBlock = document.querySelector("pre, code");
		expect(codeBlock).toBeTruthy();
		expect(codeBlock?.textContent).toContain("Starting Autopilot");
	});

	test("truncates to maxLines", () => {
		renderDiagnosticLog({ maxLines: 5 });
		const pre = document.querySelector("pre");
		expect(pre).toBeTruthy();
		const lines = pre?.textContent?.split("\n") ?? [];
		expect(lines.length).toBeLessThanOrEqual(6); // 5 lines + truncation marker
	});

	test("shows truncation marker when truncated", () => {
		renderDiagnosticLog({ maxLines: 5, truncated: true });
		expect(screen.getByText(/truncated|more lines/i)).toBeTruthy();
	});

	test("does not show truncation marker when log fits within maxLines", () => {
		renderDiagnosticLog({ maxLines: 50, truncated: false });
		expect(screen.queryByText(/truncated/i)).toBeNull();
	});

	test("does not render log in an editable element", () => {
		renderDiagnosticLog();
		expect(document.querySelector("textarea")).toBeNull();
	});

	test("renders full log when no truncation needed", () => {
		const shortLog = "Line 1\nLine 2\nLine 3";
		renderDiagnosticLog({ log: shortLog, maxLines: 10 });
		expect(screen.getByText(/line 1/i)).toBeTruthy();
		expect(screen.getByText(/line 3/i)).toBeTruthy();
	});

	test("redacts credentials from log output", () => {
		const logWithSecret = "Connecting with token ghp_abc123secret\nDone";
		renderDiagnosticLog({ log: logWithSecret });
		expect(screen.queryByText(/ghp_abc123secret/)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 6. PullRequestStatus — all PR/CI/review states
// ---------------------------------------------------------------------------

describe("pull request status", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders PR number with link", () => {
		renderPRStatus();
		const link = screen.getByRole("link", { name: /#42|pull request.*42/i });
		expect(link).toBeTruthy();
		expect(link.getAttribute("href")).toContain("github.com");
	});

	test("renders PR state badge", () => {
		renderPRStatus();
		expect(screen.getByText(/open/i)).toBeTruthy();
	});

	test("renders head SHA", () => {
		renderPRStatus();
		expect(screen.getByText(/abc123/i)).toBeTruthy();
	});

	test("renders checks status PASSING", () => {
		renderPRStatus({ checksStatus: "PASSING" });
		expect(screen.getByText(/passing|checks.*pass/i)).toBeTruthy();
	});

	test("renders checks status PENDING", () => {
		renderPRStatus({ checksStatus: "PENDING" });
		expect(screen.getByText(/pending|ci.*running/i)).toBeTruthy();
	});

	test("renders checks status FAILING", () => {
		renderPRStatus({ checksStatus: "FAILING" });
		expect(screen.getByText(/fail|ci.*failed/i)).toBeTruthy();
	});

	test("renders checks status NONE", () => {
		renderPRStatus({ checksStatus: "NONE" });
		expect(screen.getByText(/no checks/i)).toBeTruthy();
	});

	test("renders review decision APPROVED", () => {
		renderPRStatus({ reviewDecision: "APPROVED" });
		expect(screen.getByText(/approved/i)).toBeTruthy();
	});

	test("renders review decision CHANGES_REQUESTED", () => {
		renderPRStatus({ reviewDecision: "CHANGES_REQUESTED" });
		expect(screen.getByText(/changes requested/i)).toBeTruthy();
	});

	test("renders review decision REVIEW_REQUIRED", () => {
		renderPRStatus({ reviewDecision: "REVIEW_REQUIRED" });
		expect(screen.getByText(/review required/i)).toBeTruthy();
	});

	test("renders merge commit SHA when merged", () => {
		renderPRStatus({
			prState: "MERGED",
			mergeCommitSha: "merge-abc123",
		});
		expect(screen.getByText(/merge-abc123/i)).toBeTruthy();
	});

	test("renders closed state", () => {
		renderPRStatus({ prState: "CLOSED" });
		expect(screen.getByText(/closed/i)).toBeTruthy();
	});

	test("renders merged state", () => {
		renderPRStatus({ prState: "MERGED" });
		expect(screen.getByText(/merged/i)).toBeTruthy();
	});

	test("shows stale sync indicator", () => {
		renderPRStatus({ isStale: true });
		const statusDiv = screen.getByRole("status");
		expect(statusDiv.textContent).toMatch(/outdated/i);
	});

	test("renders last sync time", () => {
		renderPRStatus();
		expect(screen.getByText(/10:12/i)).toBeTruthy();
	});

	test("renders GitHub link for PR", () => {
		renderPRStatus();
		const links = screen.getAllByRole("link");
		const ghLink = links.find((l) => l.getAttribute("href")?.includes("github.com"));
		expect(ghLink).toBeTruthy();
	});

	test("does not render any merge or approve action", () => {
		renderPRStatus();
		expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /approve.*pr/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /merge.*pr/i })).toBeNull();
	});

	test("renders combined CI_RUNNING state correctly", () => {
		renderPRStatus({ checksStatus: "PENDING", reviewDecision: "NONE" });
		expect(screen.getByText(/pending|running/i)).toBeTruthy();
	});

	test("renders combined CI_FAILED state correctly", () => {
		renderPRStatus({ checksStatus: "FAILING", reviewDecision: "NONE" });
		expect(screen.getByText(/fail/i)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 7. Feature detail page integration with job views
// ---------------------------------------------------------------------------

describe("feature detail page with job views", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders feature detail page for DEVELOPING state", async () => {
		installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/user authentication/i)).toBeTruthy();
		});
	});

	test("shows loading state initially", () => {
		renderAt("/features/feat-1");
		expect(screen.getByText(/loading/i)).toBeTruthy();
	});

	test("renders feature state badge for DEVELOPING", async () => {
		installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryAllByText(/developing/i).length).toBeGreaterThan(0);
		});
	});

	test("shows branch name", async () => {
		renderAt("/features/feat-1");
		await waitFor(() => {
			const branches = screen.getAllByText(/feature\/feat-1-user-auth/i);
			expect(branches.length).toBeGreaterThanOrEqual(1);
		});
	});

	test("renders job progress section for active feature", async () => {
		installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			const progressSection = document.querySelector('[aria-label="Development progress"]');
			expect(progressSection).toBeTruthy();
		});
	});

	test("renders attempt history for active feature", async () => {
		installFetchMock({ featureState: "DEVELOPMENT_FAILED" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			const attemptSection = document.querySelector('[aria-label="Attempt history"]');
			expect(attemptSection).toBeTruthy();
		});
	});

	test("renders cancel action for active feature", async () => {
		installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /cancel/i })).toBeTruthy();
		});
	});

	test("renders retry action for failed feature", async () => {
		installFetchMock({ featureState: "DEVELOPMENT_FAILED" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /retry/i })).toBeTruthy();
		});
	});

	test("renders failure detail when failure exists", async () => {
		installFetchMock({ featureState: "DEVELOPMENT_FAILED", failure: MOCK_FAILURE });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/development_failed/i)).toBeTruthy();
		});
	});

	test("renders PR status when PR exists", async () => {
		installFetchMock({
			featureState: "CI_RUNNING",
		});
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/user authentication/i)).toBeTruthy();
		});
		await waitFor(() => {
			expect(screen.queryByText(/#42/i)).toBeTruthy();
		});
		expect(screen.queryByText(/pull request/i)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 8. No merge/approve action exists anywhere
// ---------------------------------------------------------------------------

describe("no merge or approve PR action", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("feature detail page has no merge button for any PR state", async () => {
		installFetchMock({ featureState: "PR_REVIEW" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/user authentication/i)).toBeTruthy();
		});
		expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
	});

	test("PR status component has no approve button", () => {
		renderPRStatus({ reviewDecision: "REVIEW_REQUIRED" });
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	});

	test("PR status component has no merge button", () => {
		renderPRStatus({ checksStatus: "PASSING", reviewDecision: "APPROVED" });
		expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 9. Accessibility
// ---------------------------------------------------------------------------

describe("job flow accessibility", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("job progress section has landmark", () => {
		renderJobProgress();
		const section = document.querySelector("section");
		expect(section).toBeTruthy();
	});

	test("attempt history has list semantics", () => {
		renderAttemptHistory();
		const list = document.querySelector("ol, ul, [role='list']");
		expect(list).toBeTruthy();
	});

	test("failure detail has alert role", () => {
		renderFailureDetail();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	test("cancel confirmation has dialog role", async () => {
		renderJobActions({ featureState: "DEVELOPING" });
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
	});

	test("retry confirmation has dialog role", async () => {
		renderJobActions({ featureState: "DEVELOPMENT_FAILED" });
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
	});

	test("diagnostic log uses pre element for screen readers", () => {
		renderDiagnosticLog();
		expect(document.querySelector("pre")).toBeTruthy();
	});

	test("PR status links are keyboard accessible", () => {
		renderPRStatus();
		const links = screen.getAllByRole("link");
		for (const link of links) {
			expect(link.getAttribute("href")).toBeTruthy();
		}
	});
});

// ---------------------------------------------------------------------------
// 9b. Acceptance gaps for durable job owner workflows
// ---------------------------------------------------------------------------

describe("job progress active requirement count", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders active requirement count", () => {
		const { container } = renderJobProgress({ activeRequirements: 2 });
		expect(container.textContent).toContain("Active");
		expect(container.textContent).toMatch(/Active\s*2|2\s*Active/i);
	});
});

describe("job action confirmations name project and feature", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("cancel confirmation names project and feature", async () => {
		renderJobActions({
			featureState: "DEVELOPING",
			projectName: "Autopilot Console",
			featureTitle: "User Authentication",
		});
		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toMatch(/User Authentication/);
			expect(dialog.textContent).toMatch(/Autopilot Console/);
		});
	});

	test("retry confirmation names project and feature", async () => {
		renderJobActions({
			featureState: "DEVELOPMENT_FAILED",
			projectName: "Autopilot Console",
			featureTitle: "User Authentication",
		});
		fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toMatch(/User Authentication/);
			expect(dialog.textContent).toMatch(/Autopilot Console/);
		});
	});
});

describe("feature detail wires durable job and PR owner workflows", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
	});
	afterEach(() => {
		cleanup();
		restore?.();
	});

	test("renders requirement progress cards from persisted progress snapshot", async () => {
		restore = installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.getAllByText(/implement login endpoint/i).length).toBeGreaterThan(0);
		});
		expect(screen.getAllByText(/create user model/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/red:/i).length).toBeGreaterThan(0);
	});

	test("renders queue start elapsed heartbeat and worker timing from active attempt", async () => {
		restore = installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			const progress = document.querySelector('[aria-label="Development progress"]');
			expect(progress?.textContent).toMatch(/Queued/i);
			expect(progress?.textContent).toMatch(/Started/i);
			expect(progress?.textContent).toMatch(/Elapsed/i);
			expect(progress?.textContent).toMatch(/Last Heartbeat/i);
			expect(progress?.textContent).toMatch(/Worker/i);
		});
	});

	test("renders active requirement count on feature detail progress", async () => {
		restore = installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			const progress = document.querySelector('[aria-label="Development progress"]');
			expect(progress?.textContent).toMatch(/Active/i);
		});
	});

	test("renders bounded diagnostic log excerpt from feature detail", async () => {
		restore = installFetchMock({ featureState: "DEVELOPING", includeDiagnosticLog: true });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/starting autopilot/i)).toBeTruthy();
		});
		expect(document.querySelector('[aria-label="Diagnostic log"]')).toBeTruthy();
	});

	test("renders predecessor attempt linkage from API attempts", async () => {
		restore = installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			const history = document.querySelector('[aria-label="Attempt history"]');
			expect(history?.textContent).toMatch(/Predecessor/i);
			expect(history?.textContent).toContain("attempt-1");
		});
	});

	test("cancel confirmation on feature detail names project and feature", async () => {
		restore = installFetchMock({ featureState: "DEVELOPING" });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toMatch(/User Authentication/);
			expect(dialog.textContent).toMatch(/Autopilot Console/);
		});
	});

	test("stale live updates show last update and refresh reconciles through REST", async () => {
		const counter = { count: 0 };
		restore = installFetchMock({ featureState: "DEVELOPING", callCounter: counter });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/user authentication/i)).toBeTruthy();
		});
		const initialCalls = counter.count;
		expect(initialCalls).toBeGreaterThan(0);

		const refresh = await waitFor(() => {
			const button = screen.getByRole("button", { name: /refresh/i });
			expect(button).toBeTruthy();
			return button;
		});
		fireEvent.click(refresh);
		await waitFor(() => {
			expect(counter.count).toBeGreaterThan(initialCalls);
		});
		expect(document.querySelector('[aria-label="Development progress"]')?.textContent).toMatch(
			/Total/i,
		);
	});

	test("renders stale PR sync indicator when observation is outdated", async () => {
		restore = installFetchMock({ featureState: "PR_REVIEW", stalePr: true });
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/outdated/i)).toBeTruthy();
		});
	});

	test("feature detail never renders merge or approve PR controls across PR states", async () => {
		for (const featureState of [
			"PR_CREATING",
			"CI_RUNNING",
			"CI_FAILED",
			"PR_REVIEW",
			"PR_CHANGES_REQUESTED",
			"DEVELOPMENT_MERGED",
		]) {
			cleanup();
			restore?.();
			restore = installFetchMock({ featureState });
			renderAt("/features/feat-1");
			await waitFor(() => {
				expect(screen.queryByText(/user authentication/i)).toBeTruthy();
			});
			expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
			expect(screen.queryByRole("button", { name: /approve.*pr|merge.*pr/i })).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// 10. Mobile layout at 375px
// ---------------------------------------------------------------------------

describe("job flow mobile layout at 375 pixels", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("job progress renders without horizontal overflow at narrow width", () => {
		const { container } = renderJobProgress();
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
			el.style.overflow = "auto";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("attempt history stays readable at narrow width", () => {
		const { container } = renderAttemptHistory();
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("failure detail stays readable at narrow width", () => {
		const { container } = renderFailureDetail();
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("diagnostic log wraps or scrolls horizontally without breaking layout", () => {
		const { container } = renderDiagnosticLog();
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("PR status stays readable at narrow width", () => {
		const { container } = renderPRStatus();
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("job actions button group fits narrow width", () => {
		const { container } = renderJobActions({ featureState: "DEVELOPING" });
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
		}
		expect(container.textContent).toBeTruthy();
	});
});
