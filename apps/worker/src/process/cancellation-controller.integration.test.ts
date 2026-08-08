import { describe, expect, test } from "bun:test";
import type { AutopilotRunHandle, SignalKind } from "../../../../packages/autopilot/src/index";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	ProjectRow,
	TaskApprovalRow,
} from "../../../../packages/database/src/index";

import type {
	CancellationController,
	CancelOutcome,
	ProcessTreeInspector,
} from "./cancellation-controller";

// ---------------------------------------------------------------------------
// Shared test clock
// ---------------------------------------------------------------------------
const NOW = new Date("2026-07-18T16:00:00.000Z");

function later(ms: number): Date {
	return new Date(NOW.getTime() + ms);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface Seed {
	attempt: DevelopmentAttemptRow;
	feature: FeatureRow;
	project: ProjectRow;
	approval: TaskApprovalRow;
	handle: AutopilotRunHandle;
}

function seed(
	options: {
		status?: "QUEUED" | "RUNNING";
		processIdentity?: boolean;
		mismatchedIdentity?: boolean;
	} = {},
): Seed {
	const projectId = crypto.randomUUID();
	const featureId = crypto.randomUUID();
	const attemptId = crypto.randomUUID();
	const branch = `feature/${featureId}-login`;
	const pid = 4242;
	const startTime = 987_654;

	const project: ProjectRow = {
		id: projectId,
		workspaceId: crypto.randomUUID(),
		name: "Project A",
		slug: "project-a",
		description: null,
		githubOwner: "acme",
		githubRepo: "project-a",
		canonicalPath: "/workspaces/project-a",
		developmentBranch: "main",
		validationStatus: "valid",
		lastValidatedAt: NOW,
		status: "active",
		archivedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
	};

	const feature: FeatureRow = {
		id: featureId,
		projectId,
		releaseId: crypto.randomUUID(),
		slug: "login",
		title: "Login Feature",
		summary: null,
		state: options.status === "QUEUED" ? "QUEUED" : "DEVELOPING",
		branchName: branch,
		taskPath: "docs/tasks/login.json",
		rowVersion: 5,
		archivedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
	};

	const attempt: DevelopmentAttemptRow = {
		id: attemptId,
		projectId,
		featureId,
		taskApprovalId: crypto.randomUUID(),
		branchName: branch,
		operationKey: `develop:${attemptId}`,
		status: options.status ?? "QUEUED",
		predecessorAttemptId: null,
		workerRegistrationId: options.status === "RUNNING" ? crypto.randomUUID() : null,
		processPid: options.status === "RUNNING" && options.processIdentity !== false ? pid : null,
		processStartIdentity:
			options.status === "RUNNING" && options.processIdentity !== false
				? options.mismatchedIdentity
					? "999_999"
					: String(startTime)
				: null,
		leaseExpiresAt: options.status === "RUNNING" ? later(30_000) : null,
		heartbeatAt: options.status === "RUNNING" ? NOW : null,
		enqueuedAt: NOW,
		startedAt: options.status === "RUNNING" ? NOW : null,
		endedAt: null,
		exitCode: null,
		cancellationRequestedAt: null,
		cancellationReason: null,
		structuredResult: null,
		createdAt: NOW,
		updatedAt: NOW,
	};

	const approval: TaskApprovalRow = {
		id: attempt.taskApprovalId,
		projectId,
		featureId,
		relativeTaskPath: "docs/tasks/login.json",
		checksum: "sha256:approved",
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [] },
		approvedByAdminId: crypto.randomUUID(),
		approvedAt: NOW,
		invalidatedAt: null,
		createdAt: NOW,
	};

	const handle: AutopilotRunHandle = {
		projectId,
		featureId,
		projectRoot: project.canonicalPath,
		taskRelativePath: approval.relativeTaskPath,
		expectedBranch: branch,
		processIdentity: { pid, startTimeMs: startTime },
		startedAt: NOW.toISOString(),
	};

	return { attempt, feature, project, approval, handle };
}

// ---------------------------------------------------------------------------
// Fake adapters
// ---------------------------------------------------------------------------

class FakeProcessTreeInspector implements ProcessTreeInspector {
	descendants: number[] = [];
	identityOk = true;
	signals: Array<{ pid: number; kind: SignalKind }> = [];
	throwOnSignal: Error | null = null;

	async getDescendants(_pid: number): Promise<number[]> {
		return [...this.descendants];
	}

	async verifyIdentity(_pid: number, _expectedStartTimeMs: number): Promise<boolean> {
		return this.identityOk;
	}

	async signal(pid: number, kind: SignalKind): Promise<void> {
		this.signals.push({ pid, kind });
		if (this.throwOnSignal) throw this.throwOnSignal;
	}
}

/**
 * In-memory implementation of CancellationController used as test reference
 * until createCancellationController is implemented. The tests are written
 * against the CancellationController interface so they validate the same
 * contract the production implementation must satisfy.
 *
 * ponytail: Delete this class and use createCancellationController import
 * once the production implementation exists. The test assertions do not change.
 */
class InMemoryCancellationController implements CancellationController {
	constructor(
		private tree: ProcessTreeInspector,
		private store: {
			saveCancelledQueued(
				attempt: DevelopmentAttemptRow,
				feature: FeatureRow,
				operationKey: string,
				reason: string,
			): Promise<void>;
			saveCancelRequested(attempt: DevelopmentAttemptRow, reason: string): Promise<void>;
			saveCancellationComplete(
				attempt: DevelopmentAttemptRow,
				feature: FeatureRow,
				operationKey: string,
			): Promise<void>;
			saveBlocked(
				attempt: DevelopmentAttemptRow,
				feature: FeatureRow,
				operationKey: string,
				reason: string,
			): Promise<void>;
			checkIdempotency(operationKey: string): Promise<CancelOutcome | null>;
		},
		private options: { graceMs?: number; now?: () => Date } = {},
	) {}

	async cancelQueued(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		reason: string,
		operationId: string,
	): Promise<CancelOutcome> {
		const prior = await this.store.checkIdempotency(operationId);
		if (prior) return { kind: "idempotent", attemptId: prior.attemptId };

		if (attempt.status !== "QUEUED") {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Only QUEUED attempts can be cancelled via cancelQueued.",
			};
		}

		await this.store.saveCancelledQueued(attempt, feature, operationId, reason);
		return { kind: "cancelled", attemptId: attempt.id };
	}

	async cancelRunning(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		handle: AutopilotRunHandle,
		reason: string,
		operationId: string,
	): Promise<CancelOutcome> {
		const prior = await this.store.checkIdempotency(operationId);
		if (prior) return { kind: "idempotent", attemptId: prior.attemptId };

		if (attempt.status !== "RUNNING") {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Only RUNNING attempts can be cancelled via cancelRunning.",
			};
		}

		// Verify project/feature identity
		if (handle.projectId !== attempt.projectId || handle.featureId !== attempt.featureId) {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Mismatched project or feature identity on handle.",
			};
		}

		// Verify PID identity before any signal
		if (attempt.processPid === null || attempt.processStartIdentity === null) {
			return {
				kind: "blocked",
				attemptId: attempt.id,
				reason: "Cannot cancel attempt with no process identity.",
			};
		}

		const identityOk = await this.tree.verifyIdentity(
			attempt.processPid,
			Number(attempt.processStartIdentity),
		);
		if (!identityOk) {
			await this.store.saveBlocked(
				attempt,
				feature,
				operationId,
				"PID reuse detected — process replaced.",
			);
			return { kind: "blocked", attemptId: attempt.id, reason: "PID reuse detected." };
		}

		// Persist CANCEL_REQUESTED metadata
		await this.store.saveCancelRequested(attempt, reason);

		// Send SIGUSR1 to wrapper PID
		await this.tree.signal(handle.processIdentity.pid, "graceful");

		// Bounded grace period
		const graceMs = this.options.graceMs ?? 5_000;
		await new Promise((r) => setTimeout(r, graceMs));

		// Check if process still alive — if so, escalate
		const stillAlive = await this.tree.verifyIdentity(
			handle.processIdentity.pid,
			handle.processIdentity.startTimeMs,
		);

		if (stillAlive) {
			// SIGTERM to descendants first, then to wrapper
			const descendants = await this.tree.getDescendants(handle.processIdentity.pid);
			for (const d of descendants) {
				await this.tree.signal(d, "term");
			}
			await this.tree.signal(handle.processIdentity.pid, "term");

			// Shorter grace for term→kill
			const killGraceMs = (this.options.graceMs ?? 5_000) / 2;
			await new Promise((r) => setTimeout(r, killGraceMs));

			const stillAliveAfterTerm = await this.tree.verifyIdentity(
				handle.processIdentity.pid,
				handle.processIdentity.startTimeMs,
			);
			if (stillAliveAfterTerm) {
				const remainingDescendants = await this.tree.getDescendants(handle.processIdentity.pid);
				for (const d of remainingDescendants) {
					await this.tree.signal(d, "kill");
				}
				await this.tree.signal(handle.processIdentity.pid, "kill");
			}
		}

		await this.store.saveCancellationComplete(attempt, feature, operationId);
		return { kind: "cancelled", attemptId: attempt.id };
	}
}

type CancelPersistence = {
	cancelledQueued: Array<{ attemptId: string; reason: string }>;
	cancelRequested: Array<{ attemptId: string; reason: string }>;
	cancellationComplete: Array<{ attemptId: string }>;
	blocked: Array<{ attemptId: string; reason: string }>;
	idempotencyMap: Map<string, CancelOutcome>;
	saveCancelledQueued(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		operationKey: string,
		reason: string,
	): Promise<void>;
	saveCancelRequested(attempt: DevelopmentAttemptRow, reason: string): Promise<void>;
	saveCancellationComplete(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		operationKey: string,
	): Promise<void>;
	saveBlocked(
		attempt: DevelopmentAttemptRow,
		feature: FeatureRow,
		operationKey: string,
		reason: string,
	): Promise<void>;
	checkIdempotency(operationKey: string): Promise<CancelOutcome | null>;
};

function makeCancelPersistence(): CancelPersistence {
	const idempotencyMap = new Map<string, CancelOutcome>();
	return {
		cancelledQueued: [],
		cancelRequested: [],
		cancellationComplete: [],
		blocked: [],
		idempotencyMap,
		async saveCancelledQueued(attempt, feature, operationKey, reason) {
			this.cancelledQueued.push({ attemptId: attempt.id, reason });
			idempotencyMap.set(operationKey, { kind: "cancelled", attemptId: attempt.id });
			(feature as { state: string }).state = "DEVELOPMENT_CANCELLED";
			(attempt as { status: string }).status = "CANCELLED";
		},
		async saveCancelRequested(attempt, reason) {
			this.cancelRequested.push({ attemptId: attempt.id, reason });
			(attempt as { status: string }).status = "CANCEL_REQUESTED";
		},
		async saveCancellationComplete(attempt, feature, operationKey) {
			this.cancellationComplete.push({ attemptId: attempt.id });
			(feature as { state: string }).state = "DEVELOPMENT_CANCELLED";
			(attempt as { status: string }).status = "CANCELLED";
			idempotencyMap.set(operationKey, { kind: "cancelled", attemptId: attempt.id });
		},
		async saveBlocked(attempt, feature, _operationKey, reason) {
			this.blocked.push({ attemptId: attempt.id, reason });
			(feature as { state: string }).state = "BLOCKED";
			(attempt as { status: string }).status = "FAILED";
		},
		async checkIdempotency(operationKey) {
			return idempotencyMap.get(operationKey) ?? null;
		},
	};
}

function makeController(
	_s: Seed,
	options: { graceMs?: number } = {},
): { ctrl: CancellationController; tree: FakeProcessTreeInspector; store: CancelPersistence } {
	const tree = new FakeProcessTreeInspector();
	const store = makeCancelPersistence();
	const ctrl = new InMemoryCancellationController(tree, store, { graceMs: 1, ...options });
	return { ctrl, tree, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cancellation controller", () => {
	// -----------------------------------------------------------------------
	// QUEUED cancellation
	// -----------------------------------------------------------------------

	test("cancels QUEUED atomically — attempt CANCELLED, feature DEVELOPMENT_CANCELLED", async () => {
		const s = seed({ status: "QUEUED" });
		const { ctrl, store } = makeController(s);

		const outcome = await ctrl.cancelQueued(s.attempt, s.feature, "no longer needed", "op:1");

		expect(outcome).toEqual({ kind: "cancelled", attemptId: s.attempt.id });
		expect(s.attempt.status).toBe("CANCELLED");
		expect(s.feature.state).toBe("DEVELOPMENT_CANCELLED");
		expect(store.cancelledQueued).toHaveLength(1);
		expect(store.cancelledQueued[0]?.reason).toBe("no longer needed");
	});

	test("cancels QUEUED without spawning a process", async () => {
		const s = seed({ status: "QUEUED" });
		const { ctrl, tree } = makeController(s);

		await ctrl.cancelQueued(s.attempt, s.feature, "n/a", "op:2");

		expect(tree.signals).toHaveLength(0);
	});

	test("duplicate QUEUED cancel is idempotent", async () => {
		const s = seed({ status: "QUEUED" });
		const { ctrl, store } = makeController(s);

		await ctrl.cancelQueued(s.attempt, s.feature, "r1", "op:dup");
		const outcome = await ctrl.cancelQueued(s.attempt, s.feature, "r2", "op:dup");

		expect(outcome.kind).toBe("idempotent");
		expect(store.cancelledQueued).toHaveLength(1);
	});

	test("cancelQueued rejects non-QUEUED attempt", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl } = makeController(s);

		const outcome = await ctrl.cancelQueued(s.attempt, s.feature, "n/a", "op:3");

		expect(outcome.kind).toBe("blocked");
	});

	// -----------------------------------------------------------------------
	// RUNNING cancellation — verified process escalation
	// -----------------------------------------------------------------------

	test("cancels RUNNING — persists CANCEL_REQUESTED, signals SIGUSR1, finalizes", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl, tree, store } = makeController(s);

		const outcome = await ctrl.cancelRunning(
			s.attempt,
			s.feature,
			s.handle,
			"owner request",
			"op:run1",
		);

		expect(outcome).toEqual({ kind: "cancelled", attemptId: s.attempt.id });
		// CANCEL_REQUESTED metadata persisted
		expect(store.cancelRequested).toHaveLength(1);
		expect(store.cancelRequested[0]?.reason).toBe("owner request");
		// SIGUSR1 sent
		expect(tree.signals.some((s) => s.kind === "graceful")).toBe(true);
		// Final: CANCELLED + DEVELOPMENT_CANCELLED
		expect(s.attempt.status).toBe("CANCELLED");
		expect(s.feature.state).toBe("DEVELOPMENT_CANCELLED");
		expect(store.cancellationComplete).toHaveLength(1);
	});

	test("does not signal on PID reuse — blocks instead", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl, tree, store } = makeController(s);
		tree.identityOk = false;

		const outcome = await ctrl.cancelRunning(s.attempt, s.feature, s.handle, "test", "op:reuse");

		expect(outcome.kind).toBe("blocked");
		expect(tree.signals).toHaveLength(0);
		expect(store.blocked).toHaveLength(1);
		expect(s.feature.state).toBe("BLOCKED");
	});

	test("does not signal on identity mismatch between handle and attempt", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl, tree } = makeController(s);
		const badHandle = { ...s.handle, projectId: crypto.randomUUID() };

		const outcome = await ctrl.cancelRunning(
			s.attempt,
			s.feature,
			badHandle,
			"test",
			"op:mismatch",
		);

		expect(outcome.kind).toBe("blocked");
		expect(tree.signals).toHaveLength(0);
	});

	test("duplicate RUNNING cancel is idempotent", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl, store } = makeController(s);

		await ctrl.cancelRunning(s.attempt, s.feature, s.handle, "r1", "op:rundup");
		const outcome = await ctrl.cancelRunning(s.attempt, s.feature, s.handle, "r2", "op:rundup");

		expect(outcome.kind).toBe("idempotent");
		expect(store.cancelRequested.length + store.cancellationComplete.length).toBeLessThanOrEqual(2);
	});

	// -----------------------------------------------------------------------
	// Graceful → escalation path
	// -----------------------------------------------------------------------

	test("escalates SIGUSR1 → SIGTERM → SIGKILL when process does not exit during grace", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl, tree } = makeController(s);
		tree.identityOk = true;
		tree.descendants = [5555, 5556];

		await ctrl.cancelRunning(s.attempt, s.feature, s.handle, "test", "op:escalate");

		const signalKinds = tree.signals.map((s) => s.kind);
		expect(signalKinds).toContain("graceful");
		expect(signalKinds).toContain("term");
		expect(signalKinds).toContain("kill");
		// Descendants also received term + kill
		for (const pid of [5555, 5556]) {
			expect(tree.signals.filter((s) => s.pid === pid && s.kind === "term")).toHaveLength(1);
			expect(tree.signals.filter((s) => s.pid === pid && s.kind === "kill")).toHaveLength(1);
		}
		expect(s.attempt.status).toBe("CANCELLED");
	});

	test("skips escalation when process exits during SIGUSR1 grace", async () => {
		const s = seed({ status: "RUNNING" });
		const { ctrl, tree } = makeController(s);
		let calls = 0;
		tree.verifyIdentity = async () => {
			calls++;
			return calls === 1; // alive initially, gone after grace
		};

		await ctrl.cancelRunning(s.attempt, s.feature, s.handle, "test", "op:exitduringgrace");

		// Only SIGUSR1 sent
		expect(tree.signals.every((s) => s.kind === "graceful")).toBe(true);
		expect(s.attempt.status).toBe("CANCELLED");
	});

	// -----------------------------------------------------------------------
	// No process identity
	// -----------------------------------------------------------------------

	test("blocks when RUNNING attempt has no process identity recorded", async () => {
		const s = seed({ status: "RUNNING", processIdentity: false });
		const { ctrl, tree } = makeController(s);

		const outcome = await ctrl.cancelRunning(s.attempt, s.feature, s.handle, "test", "op:nopid");

		expect(outcome.kind).toBe("blocked");
		expect(tree.signals).toHaveLength(0);
	});
});
