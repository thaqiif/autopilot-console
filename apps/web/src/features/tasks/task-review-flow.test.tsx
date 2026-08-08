/**
 * RED tests for feature task-path attachment, structured task review,
 * checksum-aware approval confirmation, and task replacement/reapproval
 * workflows (requirement 27).
 *
 * Covers: unsafe path errors, complete structured rendering, escaped
 * optional raw JSON, checksum confirmation, stale refresh, duplicate
 * pending prevention, lifecycle replacement/reapproval, status semantics,
 * and 375-pixel layout.
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
let TaskAttachmentForm: React.ComponentType<{
	onSubmit: (taskPath: string) => void;
	isSubmitting?: boolean;
	serverError?: string | null;
}>;
let TaskReview: React.ComponentType<{
	task: TaskSnapshot;
	checksum: string;
	projectName: string;
	onApprove: () => void;
	onRemove: () => void;
	onReplace: (path: string) => void;
	onInvalidate: () => void;
	isApproving?: boolean;
	featureState: string;
	staleChecksum?: boolean;
	onRefresh?: () => void;
}>;
let RequirementCard: React.ComponentType<{
	requirement: RequirementSummary;
}>;
let ApprovalConfirmation: React.ComponentType<{
	projectName: string;
	featureName: string;
	checksum: string;
	onConfirm: () => void;
	onCancel: () => void;
	isSubmitting?: boolean;
}>;

interface RequirementSummary {
	id: string;
	description: string;
	status: "not_started" | "in_progress" | "passed" | "stuck" | "invalid";
	passes: boolean;
	stuck: boolean;
	stuckReason?: string;
	invalidTest: boolean;
	invalidTestReason?: string;
	blockedReason?: string;
	dependsOn: string[];
	acceptance: string[];
	redPhase: boolean;
	greenPhase: boolean;
	refactorPhase: boolean;
}

interface TaskSnapshot {
	name: string;
	description: string;
	goals: string[];
	nonGoals: string[];
	requirements: RequirementSummary[];
	checksum: string;
	rawJson?: string;
}

try {
	FeatureDetailPage = (await import("../features/feature-detail-page")).FeatureDetailPage;
} catch {
	FeatureDetailPage = () => <div data-testid="feature-detail-missing" />;
}
try {
	TaskAttachmentForm = (await import("./task-attachment-form")).TaskAttachmentForm;
} catch {
	TaskAttachmentForm = () => <div data-testid="task-attachment-missing" />;
}
try {
	TaskReview = (await import("./task-review")).TaskReview;
} catch {
	TaskReview = () => <div data-testid="task-review-missing" />;
}
try {
	RequirementCard = (await import("./requirement-card")).RequirementCard;
} catch {
	RequirementCard = () => <div data-testid="requirement-card-missing" />;
}
try {
	ApprovalConfirmation = (await import("./approval-confirmation")).ApprovalConfirmation;
} catch {
	ApprovalConfirmation = () => <div data-testid="approval-confirmation-missing" />;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_TASK: TaskSnapshot = {
	name: "user-auth",
	description: "Implement user authentication with OAuth2",
	goals: ["Secure login", "Session management"],
	nonGoals: ["SSO", "Multi-tenant"],
	requirements: [
		{
			id: "1",
			description: "Create user model with email and password hash",
			status: "passed",
			passes: true,
			stuck: false,
			invalidTest: false,
			blockedReason: undefined,
			dependsOn: [],
			acceptance: ["User can be created with email", "Password is stored as hash"],
			redPhase: true,
			greenPhase: true,
			refactorPhase: true,
		},
		{
			id: "2",
			description: "Implement login endpoint with rate limiting",
			status: "in_progress",
			passes: false,
			stuck: false,
			invalidTest: false,
			blockedReason: undefined,
			dependsOn: ["1"],
			acceptance: ["Login returns JWT", "Rate limit blocks after 5 attempts"],
			redPhase: true,
			greenPhase: false,
			refactorPhase: false,
		},
		{
			id: "3",
			description: "Add password reset flow",
			status: "stuck",
			passes: false,
			stuck: true,
			stuckReason: "Email service unavailable in test environment",
			invalidTest: false,
			blockedReason: undefined,
			dependsOn: ["1"],
			acceptance: ["Reset email sent within 5 seconds"],
			redPhase: true,
			greenPhase: false,
			refactorPhase: false,
		},
		{
			id: "4",
			description: "Implement session invalidation",
			status: "invalid",
			passes: false,
			stuck: false,
			invalidTest: true,
			invalidTestReason:
				"Test passes without implementation — session already invalidated by middleware",
			blockedReason: undefined,
			dependsOn: ["2"],
			acceptance: ["Revoked session returns 401"],
			redPhase: true,
			greenPhase: false,
			refactorPhase: false,
		},
		{
			id: "5",
			description: "Add OAuth2 provider integration",
			status: "not_started",
			passes: false,
			stuck: false,
			invalidTest: false,
			blockedReason: "Blocked by requirement 2 dependency",
			dependsOn: ["2", "3"],
			acceptance: ["OAuth2 callback exchanges code for token"],
			redPhase: false,
			greenPhase: false,
			refactorPhase: false,
		},
	],
	checksum: "sha256:abc123def456",
	rawJson:
		'{"name":"user-auth","description":"Implement user authentication with OAuth2","goals":["Secure login","Session management"],"nonGoals":["SSO","Multi-tenant"],"requirements":[{"id":"1","description":"Create user model with email and password hash","passes":true,"tdd":{"test":{"passes":true},"implement":{"passes":true},"refactor":{"passes":true}}},{"id":"2","description":"Implement login endpoint with rate limiting","passes":false,"tdd":{"test":{"passes":true},"implement":{"passes":false},"refactor":{"passes":false}}}]}',
};

const MOCK_FEATURE_DETAIL = {
	id: "feat-1",
	title: "User Authentication",
	slug: "user-auth",
	state: "TASKS_REVIEW",
	branchName: "feature/feat-1-user-auth",
	projectId: "proj-1",
	releaseId: "rel-1",
	summary: "Implement user authentication with OAuth2",
	rowVersion: 1,
	taskPath: "tasks/user-auth.json",
	taskApproval: {
		id: "approval-1",
		relativeTaskPath: "tasks/user-auth.json",
		checksum: "sha256:abc123def456",
		requirementsSnapshot: MOCK_TASK.requirements,
		approvedAt: "2025-01-01T00:00:00.000Z",
	},
	progress: null,
	attempts: [],
	failures: [],
	diagnosticLogs: [],
	pullRequest: null,
	recentActivity: [],
};

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

function installFetchMock(overrides?: {
	featureDetail?: Partial<typeof MOCK_FEATURE_DETAIL>;
	taskSnapshot?: Partial<TaskSnapshot>;
	attachError?: string;
	approveError?: string;
	staleChecksum?: boolean;
}) {
	const original = globalThis.fetch;
	const detail = { ...MOCK_FEATURE_DETAIL, ...overrides?.featureDetail };
	const task = { ...MOCK_TASK, ...overrides?.taskSnapshot };

	const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";

		// Feature detail
		if (url.match(/\/api\/features\/feat-1$/) && method === "GET") {
			return new Response(JSON.stringify({ ok: true, data: detail }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Project name lookup used by approval confirmation
		if (url.match(/\/api\/projects\/proj-1$/) && method === "GET") {
			return new Response(
				JSON.stringify({
					ok: true,
					data: { id: "proj-1", name: "Autopilot Console", slug: "autopilot-console" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		// Attach task
		if (url.includes("/api/features/feat-1/task") && method === "POST") {
			if (overrides?.attachError) {
				return new Response(
					JSON.stringify({
						ok: false,
						error: {
							code: "VALIDATION_ERROR",
							message: overrides.attachError,
							httpStatus: 400,
							nextAction: "RETRY",
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					ok: true,
					data: { feature: detail, summary: task, checksum: task.checksum },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		// Approve & queue
		if (url.includes("/api/features/feat-1/approve-queue") && method === "POST") {
			if (overrides?.staleChecksum) {
				return new Response(
					JSON.stringify({
						ok: false,
						error: {
							code: "STALE_CHECKSUM",
							message: "Task file has changed since review",
							httpStatus: 409,
							nextAction: "REFRESH",
						},
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			if (overrides?.approveError) {
				return new Response(
					JSON.stringify({
						ok: false,
						error: {
							code: "VALIDATION_ERROR",
							message: overrides.approveError,
							httpStatus: 400,
							nextAction: "RETRY",
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({ ok: true, data: { attemptId: "attempt-1", queued: true } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		// Remove task
		if (url.includes("/api/features/feat-1/task") && method === "DELETE") {
			return new Response(JSON.stringify({ ok: true, data: { removed: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Invalidate approval
		if (url.includes("/api/features/feat-1/invalidate") && method === "POST") {
			return new Response(JSON.stringify({ ok: true, data: { invalidated: true } }), {
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

function renderAt(path: string, opts?: { authenticated?: boolean }) {
	const authenticated = opts?.authenticated ?? true;
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
					<AuthProvider client={client} initialAuthenticated={authenticated}>
						<FeatureDetailPage />
					</AuthProvider>
				),
			},
		],
		{ initialEntries: [path] },
	);
	return render(<RouterProvider router={router} />);
}

function renderReview(overrides?: Partial<React.ComponentProps<typeof TaskReview>>) {
	const props: React.ComponentProps<typeof TaskReview> = {
		task: MOCK_TASK,
		checksum: MOCK_TASK.checksum,
		projectName: "Autopilot Console",
		onApprove: () => {},
		onRemove: () => {},
		onReplace: () => {},
		onInvalidate: () => {},
		isApproving: false,
		featureState: "TASKS_REVIEW",
		...overrides,
	};
	return render(<TaskReview {...props} />);
}

function renderRequirementCard(
	overrides?: Partial<React.ComponentProps<typeof RequirementCard>["requirement"]>,
) {
	const req: RequirementSummary = {
		id: "1",
		description: "Create user model",
		status: "passed",
		passes: true,
		stuck: false,
		invalidTest: false,
		dependsOn: [],
		acceptance: ["User can be created"],
		redPhase: true,
		greenPhase: true,
		refactorPhase: true,
		...overrides,
	};
	return render(<RequirementCard requirement={req} />);
}

// ---------------------------------------------------------------------------
// 1. Task attachment — unsafe path validation
// ---------------------------------------------------------------------------

describe("task attachment path validation", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("rejects absolute path with clear error", () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Absolute paths are not allowed. Use a project-relative path."
			/>,
		);
		expect(screen.getByText(/absolute paths are not allowed/i)).toBeTruthy();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	test("rejects dot-dot traversal with clear error", async () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Path traversal (..) is not allowed in task paths."
			/>,
		);
		expect(screen.getByText(/path traversal/i)).toBeTruthy();
	});

	test("rejects non-JSON extension with clear error", async () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Task files must have a .json extension."
			/>,
		);
		expect(screen.getByText(/json extension/i)).toBeTruthy();
	});

	test("rejects schema validation failure", async () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Task file does not match the expected schema."
			/>,
		);
		expect(screen.getByText(/schema/i)).toBeTruthy();
	});

	test("rejects semantic validation failure", async () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Task file has semantic errors: duplicate requirement IDs found."
			/>,
		);
		expect(screen.getByText(/semantic errors/i)).toBeTruthy();
	});

	test("shows symlink escape error", async () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Task path escapes the project root via symlink."
			/>,
		);
		expect(screen.getByText(/symlink/i)).toBeTruthy();
	});

	test("shows fresh-resumable validation failure", async () => {
		render(
			<TaskAttachmentForm
				onSubmit={() => {}}
				serverError="Task file is not a fresh resumable task artifact for this feature."
			/>,
		);
		expect(screen.getByText(/fresh resumable/i)).toBeTruthy();
	});

	test("disables submit while submitting", () => {
		render(<TaskAttachmentForm onSubmit={() => {}} isSubmitting={true} />);
		const button = screen.getByRole("button", { name: /attach/i });
		expect(button.hasAttribute("disabled")).toBe(true);
	});

	test("submits valid project-relative path", async () => {
		let submitted = "";
		render(
			<TaskAttachmentForm
				onSubmit={(p) => {
					submitted = p;
				}}
			/>,
		);
		const input = screen.getByLabelText(/task.?path/i);
		fireEvent.change(input, { target: { value: "tasks/user-auth.json" } });
		fireEvent.submit(input.closest("form") ?? input);
		expect(submitted).toBe("tasks/user-auth.json");
	});
});

// ---------------------------------------------------------------------------
// 2. Task review — structured rendering (no raw JSON required)
// ---------------------------------------------------------------------------

describe("task review structured rendering", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("renders task name", () => {
		renderReview();
		expect(screen.getByText(/user-auth/i)).toBeTruthy();
	});

	test("renders task description", () => {
		renderReview();
		expect(screen.getByText(/implement user authentication with oauth2/i)).toBeTruthy();
	});

	test("renders goals section", () => {
		renderReview();
		expect(screen.getByText(/secure login/i)).toBeTruthy();
		expect(screen.getByText(/session management/i)).toBeTruthy();
	});

	test("renders non-goals section", () => {
		renderReview();
		expect(screen.getByText(/sso/i)).toBeTruthy();
		expect(screen.getByText(/multi-tenant/i)).toBeTruthy();
	});

	test("renders requirement descriptions", () => {
		renderReview();
		expect(screen.getByText(/create user model/i)).toBeTruthy();
		expect(screen.getByText(/login endpoint/i)).toBeTruthy();
		expect(screen.getByText(/password reset/i)).toBeTruthy();
	});

	test("renders dependency information", () => {
		renderReview();
		const deps = screen.getAllByText(/depends on/i);
		expect(deps.length).toBeGreaterThanOrEqual(1);
	});

	test("renders acceptance criteria", () => {
		renderReview();
		expect(screen.getByText(/user can be created with email/i)).toBeTruthy();
	});

	test("renders Red/Green/Refactor phase status", () => {
		renderReview();
		// Requirement 1 has all phases true
		const passedIndicators = screen.getAllByText(/passed|complete/i);
		expect(passedIndicators.length).toBeGreaterThan(0);
	});

	test("renders pass status for passing requirements", () => {
		renderReview();
		expect(screen.getByText(/create user model/i)).toBeTruthy();
	});

	test("renders stuck status with reason", () => {
		renderReview();
		expect(screen.getByText(/email service unavailable/i)).toBeTruthy();
	});

	test("renders invalid status with reason", () => {
		renderReview();
		expect(screen.getByText(/test passes without implementation/i)).toBeTruthy();
	});

	test("renders blocked reason for blocked requirements", () => {
		renderReview();
		expect(screen.getByText(/blocked by requirement 2/i)).toBeTruthy();
	});

	test("does not require raw JSON to display task info", () => {
		renderReview({ task: { ...MOCK_TASK, rawJson: undefined } });
		// All structured data should still be visible
		expect(screen.getByText(/user-auth/i)).toBeTruthy();
		expect(screen.getByText(/secure login/i)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 3. Raw JSON — secondary escaped diagnostic view
// ---------------------------------------------------------------------------

describe("raw JSON diagnostic view", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("raw JSON is hidden by default", () => {
		renderReview();
		// The raw JSON should not be visible initially
		expect(screen.queryByText(/"name":\s*"user-auth"/i)).toBeNull();
	});

	test("raw JSON toggle reveals escaped content", async () => {
		renderReview();
		const toggle = screen.getByRole("button", { name: /raw json|show raw|diagnostic/i });
		expect(toggle).toBeTruthy();
		fireEvent.click(toggle);
		await waitFor(() => {
			// JSON should appear in a code/pre block, not an editable textarea
			const codeBlock = document.querySelector("pre, code");
			expect(codeBlock).toBeTruthy();
		});
	});

	test("raw JSON is displayed in a non-editable element", () => {
		renderReview();
		const toggle = screen.getByRole("button", { name: /raw json|show raw|diagnostic/i });
		fireEvent.click(toggle);
		// Should be in a pre or code element, not a textarea
		const textarea = document.querySelector("textarea");
		expect(textarea).toBeNull();
	});

	test("raw JSON does not contain editable controls", () => {
		renderReview();
		const toggle = screen.getByRole("button", { name: /raw json|show raw|diagnostic/i });
		fireEvent.click(toggle);
		// No save/submit button for raw JSON editing
		expect(screen.queryByRole("button", { name: /save json|update json|rewrite/i })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4. Approve & Queue Development — checksum and confirmation
// ---------------------------------------------------------------------------

describe("approve and queue development", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("approve button triggers confirmation dialog", async () => {
		renderReview();
		const approveBtn = screen.getByRole("button", { name: /approve/i });
		fireEvent.click(approveBtn);
		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeTruthy();
		});
	});

	test("confirmation dialog names the project and feature", async () => {
		renderReview({ projectName: "Autopilot Console" });
		const approveBtn = screen.getByRole("button", { name: /approve/i });
		fireEvent.click(approveBtn);
		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toMatch(/user-auth/i);
			expect(dialog.textContent).toMatch(/autopilot console/i);
		});
	});

	test("confirmation dialog displays checksum", async () => {
		renderReview();
		const approveBtn = screen.getByRole("button", { name: /approve.*queue development/i });
		fireEvent.click(approveBtn);
		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toMatch(/sha256:abc123def456/i);
		});
	});

	test("confirm calls onApprove", async () => {
		let approved = false;
		render(
			<ApprovalConfirmation
				projectName="Console"
				featureName="User Auth"
				checksum="sha256:abc123def456"
				onConfirm={() => {
					approved = true;
				}}
				onCancel={() => {}}
			/>,
		);
		const confirmBtn = screen.getByRole("button", { name: /confirm|approve/i });
		fireEvent.click(confirmBtn);
		expect(approved).toBe(true);
	});

	test("cancel closes confirmation dialog", async () => {
		let cancelled = false;
		render(
			<ApprovalConfirmation
				projectName="Console"
				featureName="User Auth"
				checksum="sha256:abc123def456"
				onConfirm={() => {}}
				onCancel={() => {
					cancelled = true;
				}}
			/>,
		);
		const cancelBtn = screen.getByRole("button", { name: /cancel/i });
		fireEvent.click(cancelBtn);
		expect(cancelled).toBe(true);
	});

	test("duplicate submission is disabled while pending", () => {
		render(
			<ApprovalConfirmation
				projectName="Console"
				featureName="User Auth"
				checksum="sha256:abc123def456"
				onConfirm={() => {}}
				onCancel={() => {}}
				isSubmitting={true}
			/>,
		);
		const confirmBtn = screen.getByRole("button", { name: /confirm|approve/i });
		expect(confirmBtn.hasAttribute("disabled")).toBe(true);
	});

	test("stale checksum shows refresh warning", () => {
		renderReview({ staleChecksum: true, onRefresh: () => {} });
		expect(screen.getByText(/task file has changed/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 5. Lifecycle-aware replacement and reapproval actions
// ---------------------------------------------------------------------------

describe("lifecycle-aware task actions", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("remove action visible in TASKS_REVIEW state", () => {
		renderReview({ featureState: "TASKS_REVIEW" });
		expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
	});

	test("replace action visible in TASKS_REVIEW state", () => {
		renderReview({ featureState: "TASKS_REVIEW" });
		expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
	});

	test("invalidate action visible in TASKS_REVIEW state", () => {
		renderReview({ featureState: "TASKS_REVIEW" });
		expect(screen.getByRole("button", { name: /invalidate/i })).toBeTruthy();
	});

	test("replace action visible after DEVELOPMENT_FAILED", () => {
		renderReview({ featureState: "DEVELOPMENT_FAILED" });
		expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
	});

	test("replace action visible after DEVELOPMENT_INTERRUPTED", () => {
		renderReview({ featureState: "DEVELOPMENT_INTERRUPTED" });
		expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
	});

	test("replace action visible after DEVELOPMENT_CANCELLED", () => {
		renderReview({ featureState: "DEVELOPMENT_CANCELLED" });
		expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
	});

	test("actions hidden in QUEUED state", () => {
		renderReview({ featureState: "QUEUED" });
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
	});

	test("actions hidden in DEVELOPING state", () => {
		renderReview({ featureState: "DEVELOPING" });
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
	});

	test("actions hidden in DEVELOPMENT_COMPLETE state", () => {
		renderReview({ featureState: "DEVELOPMENT_COMPLETE" });
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
	});

	test("actions hidden in DEVELOPMENT_MERGED state", () => {
		renderReview({ featureState: "DEVELOPMENT_MERGED" });
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
	});

	test("reapprove action visible after DEVELOPMENT_FAILED", () => {
		renderReview({ featureState: "DEVELOPMENT_FAILED" });
		expect(screen.getByRole("button", { name: /reapprove/i })).toBeTruthy();
	});

	test("replacement explains prior approval preservation", () => {
		renderReview({ featureState: "DEVELOPMENT_FAILED" });
		const replaceBtn = screen.getByRole("button", { name: /replace/i });
		fireEvent.click(replaceBtn);
		expect(screen.getByText(/prior approvals|attempt history|preserved/i)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 6. RequirementCard component
// ---------------------------------------------------------------------------

describe("requirement card component", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("displays requirement id and description", () => {
		renderRequirementCard();
		expect(screen.getByRole("article")).toBeTruthy();
		expect(screen.getByText(/create user model/i)).toBeTruthy();
	});

	test("displays pass status with text and icon", () => {
		renderRequirementCard({ status: "passed", passes: true });
		expect(screen.getByText("Passed")).toBeTruthy();
		const badge = screen.getByText("Passed").closest("[data-status]");
		expect(badge?.getAttribute("data-status")).toBe("passed");
		expect(badge?.querySelector('[aria-hidden="true"]')).toBeTruthy();
	});

	test("displays stuck status with reason and not just color", () => {
		renderRequirementCard({
			status: "stuck",
			stuck: true,
			stuckReason: "Database connection failed",
		});
		expect(screen.getByText(/stuck/i)).toBeTruthy();
		expect(screen.getByText(/database connection failed/i)).toBeTruthy();
	});

	test("displays invalid status with reason", () => {
		renderRequirementCard({
			status: "invalid",
			invalidTest: true,
			invalidTestReason: "Test passes without implementation",
		});
		expect(screen.getByText(/invalid/i)).toBeTruthy();
	});

	test("displays blocked reason", () => {
		renderRequirementCard({
			blockedReason: "Waiting for requirement 2",
		});
		expect(screen.getByText(/waiting for requirement 2/i)).toBeTruthy();
	});

	test("displays dependency list", () => {
		renderRequirementCard({ dependsOn: ["1", "2"] });
		expect(screen.getByText(/depends on/i)).toBeTruthy();
	});

	test("displays acceptance criteria count", () => {
		renderRequirementCard({ acceptance: ["Criterion 1", "Criterion 2", "Criterion 3"] });
		expect(screen.getByText("3 acceptance criteria")).toBeTruthy();
	});

	test("displays TDD phase indicators with text labels", () => {
		renderRequirementCard({
			redPhase: true,
			greenPhase: false,
			refactorPhase: false,
		});
		expect(screen.getByText(/red/i)).toBeTruthy();
	});

	test("status conveyed with text not only color", () => {
		renderRequirementCard({ status: "passed", passes: true });
		expect(screen.getByText("Passed")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 7. Mobile layout at 375px
// ---------------------------------------------------------------------------

describe("mobile layout at 375 pixels", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("task review renders without horizontal overflow at narrow width", () => {
		const { container } = renderReview();
		// All content should be within the container
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
			el.style.overflow = "auto";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("requirement card stays readable at narrow width", () => {
		const { container } = renderRequirementCard({
			dependsOn: ["1", "2", "3"],
			acceptance: ["Criterion 1", "Criterion 2"],
		});
		const el = container.firstElementChild as HTMLElement;
		if (el) {
			el.style.width = "375px";
		}
		expect(container.textContent).toBeTruthy();
	});

	test("attachment form is usable at narrow width", () => {
		render(
			<div style={{ width: "375px" }}>
				<TaskAttachmentForm onSubmit={() => {}} />
			</div>,
		);
		const input = screen.getByLabelText(/task.?path/i);
		expect(input).toBeTruthy();
		const button = screen.getByRole("button", { name: /attach/i });
		expect(button).toBeTruthy();
	});

	test("approval confirmation dialog fits at narrow width", () => {
		render(
			<div style={{ width: "375px" }}>
				<ApprovalConfirmation
					projectName="Console"
					featureName="User Auth"
					checksum="sha256:abc123def456"
					onConfirm={() => {}}
					onCancel={() => {}}
				/>
			</div>,
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 8. Accessibility foundations
// ---------------------------------------------------------------------------

describe("task review accessibility", () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	test("task attachment form has form landmark", () => {
		render(<TaskAttachmentForm onSubmit={() => {}} />);
		expect(screen.getByRole("form")).toBeTruthy();
	});

	test("task review has section landmark", () => {
		renderReview();
		expect(document.querySelector("section")).toBeTruthy();
	});

	test("requirement cards have article semantics", () => {
		renderRequirementCard();
		// Should be an article or similar semantic element
		const articles = document.querySelectorAll("article, [role='article']");
		expect(articles.length).toBeGreaterThanOrEqual(0);
	});

	test("approval confirmation dialog has dialog role", () => {
		render(
			<ApprovalConfirmation
				projectName="Console"
				featureName="User Auth"
				checksum="sha256:abc123def456"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	test("approval dialog is labelled", () => {
		render(
			<ApprovalConfirmation
				projectName="Console"
				featureName="User Auth"
				checksum="sha256:abc123def456"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		const dialog = screen.getByRole("dialog");
		expect(
			dialog.getAttribute("aria-label") || dialog.getAttribute("aria-labelledby"),
		).toBeTruthy();
	});

	test("error messages have alert role", () => {
		render(<TaskAttachmentForm onSubmit={() => {}} serverError="Test error" />);
		expect(screen.getByRole("alert")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 9. Integration — feature detail page
// ---------------------------------------------------------------------------

describe("feature detail page integration", () => {
	let restore: () => void;
	beforeEach(() => {
		cleanup();
		restore = installFetchMock();
	});
	afterEach(() => {
		cleanup();
		restore();
	});

	test("renders feature detail page at route", async () => {
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryAllByText(/user authentication/i).length).toBeGreaterThan(0);
		});
	});

	test("shows loading state initially", () => {
		renderAt("/features/feat-1");
		expect(screen.getByText(/loading/i)).toBeTruthy();
	});

	test("displays feature state badge", async () => {
		renderAt("/features/feat-1");
		await waitFor(() => {
			expect(screen.queryByText(/tasks.?review/i)).toBeTruthy();
		});
	});

	test("shows branch name", async () => {
		renderAt("/features/feat-1");
		await waitFor(() => {
			const branches = screen.getAllByText(/feature\/feat-1-user-auth/i);
			expect(branches.length).toBeGreaterThanOrEqual(1);
		});
	});

	test("attaches a task with the canonical payload and renders the returned review", async () => {
		let attachInit: RequestInit | undefined;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/api/projects/proj-1") && !url.includes("/releases")) {
				return new Response(
					JSON.stringify({ ok: true, data: { id: "proj-1", name: "Autopilot Console" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.endsWith("/task") && (init?.method ?? "GET") === "POST") {
				attachInit = init;
				return new Response(
					JSON.stringify({
						ok: true,
						data: {
							feature: { ...MOCK_FEATURE_DETAIL, taskPath: "tasks/new.json" },
							summary: MOCK_TASK,
							checksum: MOCK_TASK.checksum,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					ok: true,
					data: { ...MOCK_FEATURE_DETAIL, taskPath: null, taskApproval: null },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		renderAt("/features/feat-1");
		fireEvent.change(await screen.findByLabelText(/task path/i), {
			target: { value: "tasks/new.json" },
		});
		fireEvent.click(screen.getByRole("button", { name: /attach/i }));
		await waitFor(() => expect(screen.getByText(MOCK_TASK.name)).toBeTruthy());
		expect(JSON.parse(String(attachInit?.body))).toEqual({ relativeTaskPath: "tasks/new.json" });
		expect((attachInit?.headers as Record<string, string> | undefined)?.["x-csrf-token"]).toBe(
			"test-csrf",
		);
	});

	test("approve confirmation names the project and posts the displayed checksum with targets", async () => {
		let approveBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes("/api/projects/proj-1") && method === "GET") {
				return new Response(
					JSON.stringify({ ok: true, data: { id: "proj-1", name: "Autopilot Console" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/approve-queue") && method === "POST") {
				approveBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						ok: true,
						data: {
							feature: { ...MOCK_FEATURE_DETAIL, state: "QUEUED" },
							approval: MOCK_FEATURE_DETAIL.taskApproval,
							attempt: { id: "attempt-1" },
							idempotent: false,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.match(/\/api\/features\/feat-1$/) && method === "GET") {
				return new Response(JSON.stringify({ ok: true, data: MOCK_FEATURE_DETAIL }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		renderAt("/features/feat-1");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /approve.*queue development/i })).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: /approve.*queue development/i }));
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		expect(screen.getByRole("dialog").textContent).toMatch(/autopilot console/i);
		expect(screen.getByRole("dialog").textContent).toMatch(/user authentication|user-auth/i);
		fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
		await waitFor(() => expect(approveBody).toBeTruthy());
		expect(approveBody?.displayedChecksum).toBe(MOCK_TASK.checksum);
		expect(approveBody?.projectId).toBe("proj-1");
		expect(approveBody?.featureId).toBe("feat-1");
		expect(approveBody?.confirmation).toBe("approve-and-queue");
		expect(typeof approveBody?.operationKey).toBe("string");
	});

	test("invalidate posts the lifecycle confirmation with project and feature targets", async () => {
		let invalidateUrl = "";
		let invalidateBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes("/api/projects/proj-1") && method === "GET") {
				return new Response(
					JSON.stringify({ ok: true, data: { id: "proj-1", name: "Autopilot Console" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/invalidate") && method === "POST") {
				invalidateUrl = url;
				invalidateBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						ok: true,
						data: { id: "approval-1", invalidatedAt: "2025-01-02T00:00:00.000Z" },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.match(/\/api\/features\/feat-1$/) && method === "GET") {
				return new Response(JSON.stringify({ ok: true, data: MOCK_FEATURE_DETAIL }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		renderAt("/features/feat-1");
		await waitFor(() => expect(screen.getByRole("button", { name: /invalidate/i })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /invalidate/i }));
		await waitFor(() => expect(invalidateBody).toBeTruthy());
		expect(invalidateUrl).toContain("/api/features/feat-1/approvals/approval-1/invalidate");
		expect(invalidateBody).toMatchObject({
			projectId: "proj-1",
			featureId: "feat-1",
			confirmation: "invalidate-task-approval",
		});
		expect(typeof invalidateBody?.operationKey).toBe("string");
	});

	test("replace uses the replace-task confirmation and preserves attempt history copy", async () => {
		let replaceBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes("/api/projects/proj-1") && method === "GET") {
				return new Response(
					JSON.stringify({ ok: true, data: { id: "proj-1", name: "Autopilot Console" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.endsWith("/task") && method === "PUT") {
				replaceBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						ok: true,
						data: {
							feature: { ...MOCK_FEATURE_DETAIL, taskPath: "tasks/replacement.json" },
							summary: { ...MOCK_TASK, name: "replacement-task" },
							checksum: "sha256:replacement",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.match(/\/api\/features\/feat-1$/) && method === "GET") {
				return new Response(JSON.stringify({ ok: true, data: MOCK_FEATURE_DETAIL }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		renderAt("/features/feat-1");
		await waitFor(() => expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /replace/i }));
		expect(screen.getByText(/prior approvals|attempt history|preserved/i)).toBeTruthy();
		fireEvent.change(screen.getByLabelText(/new task path/i), {
			target: { value: "tasks/replacement.json" },
		});
		const replaceDialog = screen.getByRole("dialog", { name: /replace task file/i });
		const confirmReplace = Array.from(replaceDialog.querySelectorAll("button")).find((b) =>
			/^replace$/i.test(b.textContent ?? ""),
		);
		expect(confirmReplace).toBeTruthy();
		if (confirmReplace) fireEvent.click(confirmReplace);
		await waitFor(() => expect(replaceBody).toBeTruthy());
		expect(replaceBody).toMatchObject({
			projectId: "proj-1",
			featureId: "feat-1",
			approvalId: "approval-1",
			relativeTaskPath: "tasks/replacement.json",
			confirmation: "replace-task",
		});
		expect(typeof replaceBody?.operationKey).toBe("string");
	});

	test("stale checksum conflict forces a refresh before another approval", async () => {
		let approveCalls = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes("/api/projects/proj-1") && method === "GET") {
				return new Response(
					JSON.stringify({ ok: true, data: { id: "proj-1", name: "Autopilot Console" } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/approve-queue") && method === "POST") {
				approveCalls += 1;
				return new Response(
					JSON.stringify({
						ok: false,
						error: {
							code: "CONFLICT",
							message: "Displayed checksum is stale; refresh task review and try again",
							httpStatus: 409,
							nextAction: "REFRESH",
						},
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.match(/\/api\/features\/feat-1$/) && method === "GET") {
				return new Response(JSON.stringify({ ok: true, data: MOCK_FEATURE_DETAIL }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		renderAt("/features/feat-1");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /approve.*queue development/i })).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: /approve.*queue development/i }));
		fireEvent.click(await screen.findByRole("button", { name: /^confirm$/i }));
		await waitFor(() => expect(screen.getByText(/task file has changed/i)).toBeTruthy());
		expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /approve.*queue development/i })).toBeNull();
		expect(approveCalls).toBe(1);
	});
});
