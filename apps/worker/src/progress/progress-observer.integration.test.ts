/**
 * Progress Observer integration tests (requirement 18).
 *
 * Covers: atomic/malformed snapshot updates, periodic snapshots with fake time,
 * monotonic ordering, phase/activity derivation, notes/analytics/commit ingestion,
 * redacted bounded logs, truncation, pagination, and restart reconstruction.
 */
import { describe, expect, test } from "bun:test";

import type {
	ActivityEventRow,
	ActivityPage,
} from "../../../../packages/domain/src/activity/activity-types";
import type {
	DiagnosticLogChunkRow,
	ProgressSnapshotRow,
	ProgressSummary,
	TaskRequirementState,
} from "../../../../packages/domain/src/progress/progress-summary";
import { createProgressObserver } from "./progress-observer";

// ─── Fake store ─────────────────────────────────────────────────────────────

interface TestStore {
	snapshots: ProgressSnapshotRow[];
	activity: ActivityEventRow[];
	diagnostics: DiagnosticLogChunkRow[];
}

function createTestStore(): TestStore {
	return { snapshots: [], activity: [], diagnostics: [] };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFixture(count: number): TaskRequirementState[] {
	return Array.from({ length: count }, (_, i) => ({
		id: String(i + 1),
		description: `Requirement ${i + 1}`,
		passes: false,
		stuck: false,
		invalidTest: false,
		blockedReason: null,
		tdd: { test: { passes: false }, implement: { passes: false }, refactor: { passes: false } },
		dependsOn: i > 0 ? [String(i)] : [],
		acceptance: [`Must satisfy ${i + 1}`],
	}));
}

function summarise(snap: ProgressSnapshotRow): ProgressSummary {
	return snap.summary as ProgressSummary;
}

const PROJECT_ID = crypto.randomUUID();
const FEATURE_ID = crypto.randomUUID();
const ATTEMPT_ID = crypto.randomUUID();
const NOW = new Date("2026-07-18T16:00:00.000Z");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("progress observer", () => {
	// ── Snapshot lifecycle ───────────────────────────────────────────────

	test("atomic snapshot persists with monotonic version", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const reqs = makeFixture(3);
		const snap = (await obs.snapshotTask({
			requirements: reqs,
			sourceVersion: 1,
		})) as ProgressSnapshotRow;

		expect(snap.sourceVersion).toBe(1);
		expect(snap.projectId).toBe(PROJECT_ID);
		expect(summarise(snap).total).toBe(3);
		expect(summarise(snap).remaining).toBe(3);
		expect(summarise(snap).allPass).toBe(false);
	});

	test("monotonic version enforcement rejects rewind", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		await obs.snapshotTask({ requirements: makeFixture(1), sourceVersion: 5 });
		await expect(
			obs.snapshotTask({ requirements: makeFixture(1), sourceVersion: 3 }),
		).rejects.toThrow("monotonic");
	});

	test("malformed task retains last valid snapshot and emits diagnostic event", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const valid = (await obs.snapshotTask({
			requirements: makeFixture(2),
			sourceVersion: 1,
		})) as ProgressSnapshotRow;
		expect(store.snapshots.length).toBe(1);

		await expect(
			obs.snapshotTask({
				requirements: null as unknown as TaskRequirementState[],
				sourceVersion: 2,
			}),
		).rejects.toThrow("malformed");

		expect(store.snapshots.length).toBe(1);
		expect(store.snapshots[0]?.id).toBe(valid.id);

		const malformedEvents = store.activity.filter((e) => e.type === "progress.malformed");
		expect(malformedEvents.length).toBe(1);
		expect(malformedEvents[0]?.summary).toContain("malformed");
	});

	test("periodic snapshots accumulate and latest is queryable", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		await obs.snapshotTask({ requirements: makeFixture(2), sourceVersion: 1 });
		await obs.snapshotTask({ requirements: makeFixture(2), sourceVersion: 2 });

		const latest = (await obs.getLatestSnapshot()) as ProgressSnapshotRow;
		expect(latest).not.toBeNull();
		expect(latest.sourceVersion).toBe(2);
		expect(store.snapshots.length).toBe(2);
	});

	test("phase and dependency summaries are computed", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const reqs: TaskRequirementState[] = [
			{
				id: "1",
				description: "Base",
				passes: true,
				stuck: false,
				invalidTest: false,
				blockedReason: null,
				tdd: { test: { passes: true }, implement: { passes: true }, refactor: { passes: true } },
				dependsOn: [],
				acceptance: ["works"],
			},
			{
				id: "2",
				description: "Blocked",
				passes: false,
				stuck: true,
				invalidTest: false,
				blockedReason: "missing dep",
				tdd: { test: { passes: true }, implement: { passes: false }, refactor: { passes: false } },
				dependsOn: ["99"],
				acceptance: ["works"],
			},
			{
				id: "3",
				description: "Pending",
				passes: false,
				stuck: false,
				invalidTest: false,
				blockedReason: null,
				tdd: { test: { passes: false }, implement: { passes: false }, refactor: { passes: false } },
				dependsOn: ["1"],
				acceptance: ["works"],
			},
		];

		const snap = (await obs.snapshotTask({
			requirements: reqs,
			sourceVersion: 1,
		})) as ProgressSnapshotRow;
		const s = summarise(snap);

		expect(s.total).toBe(3);
		expect(s.passed).toBe(1);
		expect(s.stuck).toBe(1);
		expect(s.remaining).toBe(1);
		expect(s.phaseSummary.red).toBe(2);
		expect(s.phaseSummary.green).toBe(1);
		expect(s.phaseSummary.refactor).toBe(1);
		expect(s.blockedReasons.length).toBe(1);
		expect(s.blockedReasons[0]?.id).toBe("2");
		expect(s.dependencySummary.blocked).toBe(1);
		expect(s.dependencySummary.ready).toBe(2);
	});

	// ── Activity derivation ──────────────────────────────────────────────

	test("activity derivation produces typed events", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const ev = (await obs.deriveActivity({
			type: "task.requirement.passed",
			summary: "Requirement 1 passed all TDD phases",
			metadata: { requirementId: "1" },
		})) as ActivityEventRow;

		expect(ev.type).toBe("task.requirement.passed");
		expect(ev.projectId).toBe(PROJECT_ID);
		expect(ev.attemptId).toBe(ATTEMPT_ID);
		expect(ev.source).toBe("progress-observer");
	});

	test("notes/analytics/commit ingestion emits typed activity", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		await obs.deriveActivity({ type: "notes.updated", summary: "Notes updated" });
		await obs.deriveActivity({ type: "analytics.updated", summary: "Analytics updated" });
		await obs.deriveActivity({
			type: "commit.detected",
			summary: "3 new commits",
			metadata: { commitCount: 3 },
		});

		const types = store.activity.map((e) => e.type);
		expect(types).toContain("notes.updated");
		expect(types).toContain("analytics.updated");
		expect(types).toContain("commit.detected");
	});

	// ── Diagnostic logs ─────────────────────────────────────────────────

	test("diagnostic chunks are ordered by sequence", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		await obs.appendDiagnostic("stdout", "line 1\n");
		await obs.appendDiagnostic("stdout", "line 2\n");
		await obs.appendDiagnostic("stderr", "error 1\n");

		expect(store.diagnostics.length).toBe(3);
		expect(store.diagnostics[0]?.sequence).toBe(1);
		expect(store.diagnostics[1]?.sequence).toBe(2);
		expect(store.diagnostics[2]?.sequence).toBe(3);
		expect(store.diagnostics[0]?.stream).toBe("stdout");
		expect(store.diagnostics[2]?.stream).toBe("stderr");
	});

	test("diagnostic is bounded and truncated with marker", async () => {
		const store = createTestStore();
		const maxBytes = 100;
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
			maxDiagnosticBytes: maxBytes,
		});

		const bigBody = "x".repeat(500);
		const chunk = (await obs.appendDiagnostic("stdout", bigBody)) as DiagnosticLogChunkRow;

		expect(chunk.truncated).toBe(true);
		expect(chunk.body).toContain("…[TRUNCATED]");
		expect(Buffer.byteLength(chunk.body, "utf8")).toBeLessThanOrEqual(maxBytes);
	});

	test("small diagnostic is not truncated", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const chunk = (await obs.appendDiagnostic("stdout", "short message")) as DiagnosticLogChunkRow;
		expect(chunk.truncated).toBe(false);
		expect(chunk.body).toBe("short message");
	});

	// ── Activity pagination ─────────────────────────────────────────────

	test("activity is cursor-paginated", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		for (let i = 0; i < 5; i++) {
			await obs.deriveActivity({
				type: `test.event.${i}`,
				summary: `Event ${i}`,
			});
		}

		const page1 = (await obs.listActivity({ limit: 2 })) as ActivityPage;
		expect(page1.items.length).toBe(2);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = (await obs.listActivity({
			limit: 2,
			cursor: page1.nextCursor ?? undefined,
		})) as ActivityPage;
		expect(page2.items.length).toBe(2);

		const page3 = (await obs.listActivity({
			limit: 2,
			cursor: page2.nextCursor ?? undefined,
		})) as ActivityPage;
		expect(page3.items.length).toBe(1);
		expect(page3.nextCursor).toBeNull();

		const allSeen = page1.items.length + page2.items.length + page3.items.length;
		expect(allSeen).toBe(5);
	});

	test("empty activity list returns empty page", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const page = (await obs.listActivity()) as ActivityPage;
		expect(page.items).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});

	// ── Restart reconstruction ──────────────────────────────────────────

	test("observer state is reconstructible from store after restart", async () => {
		const store = createTestStore();

		const obs1 = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		await obs1.snapshotTask({ requirements: makeFixture(2), sourceVersion: 1 });
		await obs1.deriveActivity({ type: "task.started", summary: "Work started" });
		await obs1.appendDiagnostic("stdout", "starting...");

		// Second "session": new observer with same store
		const obs2 = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		const latest = (await obs2.getLatestSnapshot()) as ProgressSnapshotRow;
		expect(latest).not.toBeNull();
		expect(latest.sourceVersion).toBe(1);

		const activityPage = (await obs2.listActivity()) as ActivityPage;
		expect(activityPage.items.length).toBe(1);
		expect(activityPage.items[0]?.type).toBe("task.started");

		const diagnostics = (obs2.read() as { diagnostics: DiagnosticLogChunkRow[] }).diagnostics;
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0]?.body).toBe("starting...");
	});

	test("getLatestSnapshot returns null when no snapshots exist", async () => {
		const store = createTestStore();
		const obs = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		expect(await obs.getLatestSnapshot()).toBeNull();
	});

	test("concurrent observers share state via store", async () => {
		const store = createTestStore();
		const obs1 = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});
		const obs2 = createProgressObserver(store, {
			projectId: PROJECT_ID,
			featureId: FEATURE_ID,
			attemptId: ATTEMPT_ID,
			now: () => NOW,
		});

		await obs1.snapshotTask({ requirements: makeFixture(1), sourceVersion: 1 });
		await obs2.deriveActivity({ type: "concurrent.event", summary: "From obs2" });

		const page = (await obs1.listActivity()) as ActivityPage;
		expect(page.items.some((e) => e.type === "concurrent.event")).toBe(true);

		const latest = (await obs2.getLatestSnapshot()) as ProgressSnapshotRow;
		expect(latest.sourceVersion).toBe(1);
	});
});
