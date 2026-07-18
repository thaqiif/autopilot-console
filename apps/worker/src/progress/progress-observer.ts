/**
 * Progress observer — captures task snapshots, derives activity,
 * writes bounded diagnostic logs, and supports paginated queries.
 */
import type { ActivityEventRow } from "../../../../packages/domain/src/activity/activity-types";
import type {
	DiagnosticLogChunkRow,
	ProgressSnapshotRow,
	ProgressSummary,
	TaskRequirementState,
	TaskSnapshotInput,
} from "../../../../packages/domain/src/progress/progress-summary";

export interface ProgressObserver {
	snapshotTask(task: TaskSnapshotInput): Promise<ProgressSnapshotRow>;
	deriveActivity(params: {
		type: string;
		summary: string;
		metadata?: unknown;
	}): Promise<ActivityEventRow>;
	appendDiagnostic(stream: "stdout" | "stderr", body: string): Promise<DiagnosticLogChunkRow>;
	listActivity(opts?: { cursor?: string; limit?: number }): Promise<{
		items: ActivityEventRow[];
		nextCursor: string | null;
	}>;
	getLatestSnapshot(): Promise<ProgressSnapshotRow | null>;
	read(): {
		snapshots: ProgressSnapshotRow[];
		activity: ActivityEventRow[];
		diagnostics: DiagnosticLogChunkRow[];
	};
	readonly lastVersion: number;
}

export interface ProgressObserverOptions {
	projectId: string;
	featureId: string;
	attemptId: string;
	maxDiagnosticBytes?: number;
	now?: () => Date;
}

interface Store {
	snapshots: ProgressSnapshotRow[];
	activity: ActivityEventRow[];
	diagnostics: DiagnosticLogChunkRow[];
}

const TRUNCATION_MARKER = "\n…[TRUNCATED]";

export function createProgressObserver(
	store: Store,
	options: ProgressObserverOptions,
): ProgressObserver {
	const now = options.now ?? (() => new Date());
	const maxDiagnosticBytes = options.maxDiagnosticBytes ?? 64 * 1024;
	let version = 0;
	let diagSequence = 0;

	function computeSummary(reqs: TaskRequirementState[]): ProgressSummary {
		const total = reqs.length;
		const passed = reqs.filter((r) => r.passes).length;
		const stuck = reqs.filter((r) => r.stuck).length;
		const invalidTest = reqs.filter((r) => r.invalidTest).length;
		const remaining = total - passed - stuck - invalidTest;
		const allPass = passed === total;
		const blockedReasons = reqs
			.filter((r) => r.blockedReason != null)
			.map((r) => ({ id: r.id, reason: r.blockedReason ?? "" }));

		const phaseSummary = {
			red: reqs.filter((r) => r.tdd?.test?.passes).length,
			green: reqs.filter((r) => r.tdd?.implement?.passes).length,
			refactor: reqs.filter((r) => r.tdd?.refactor?.passes).length,
		};

		const ready = reqs.filter((r) => {
			if (r.dependsOn == null || r.dependsOn.length === 0) return true;
			return r.dependsOn.every((depId) => reqs.some((dr) => dr.id === depId && dr.passes));
		}).length;
		const dependencySummary = { blocked: total - ready, ready };

		return {
			total,
			passed,
			stuck,
			invalidTest,
			remaining,
			allPass,
			blockedReasons,
			phaseSummary,
			dependencySummary,
		};
	}

	return {
		get lastVersion() {
			return version;
		},

		read() {
			return {
				snapshots: [...store.snapshots],
				activity: [...store.activity],
				diagnostics: [...store.diagnostics],
			};
		},

		async snapshotTask(task) {
			const sourceVersion = task.sourceVersion;
			if (sourceVersion <= version) {
				throw new Error("monotonic violation");
			}

			if (!task.requirements || !Array.isArray(task.requirements)) {
				store.activity.push({
					id: crypto.randomUUID(),
					projectId: options.projectId,
					featureId: options.featureId,
					attemptId: options.attemptId,
					type: "progress.malformed",
					summary: "Task snapshot rejected: malformed requirements array",
					source: "progress-observer",
					metadata: null,
					occurredAt: now(),
					createdAt: now(),
				});
				throw new Error("malformed task");
			}

			const summary = computeSummary(task.requirements);
			version = sourceVersion;

			const snapshot: ProgressSnapshotRow = {
				id: crypto.randomUUID(),
				projectId: options.projectId,
				featureId: options.featureId,
				attemptId: options.attemptId,
				sourceVersion,
				summary,
				requirements: task.requirements,
				createdAt: now(),
			};

			store.snapshots.push(snapshot);
			return snapshot;
		},

		async deriveActivity(params) {
			const event: ActivityEventRow = {
				id: crypto.randomUUID(),
				projectId: options.projectId,
				featureId: options.featureId,
				attemptId: options.attemptId,
				type: params.type,
				summary: params.summary,
				source: "progress-observer",
				metadata: params.metadata ?? null,
				occurredAt: now(),
				createdAt: now(),
			};
			store.activity.push(event);
			return event;
		},

		async appendDiagnostic(stream, body) {
			const max = maxDiagnosticBytes;
			const marker = TRUNCATION_MARKER;
			const raw = Buffer.from(body ?? "", "utf8");
			const keep = Math.max(0, max - Buffer.byteLength(marker, "utf8"));
			const truncated = raw.byteLength > max;
			const safeBody = truncated ? `${raw.subarray(0, keep).toString("utf8")}${marker}` : body;

			diagSequence += 1;
			const chunk: DiagnosticLogChunkRow = {
				id: crypto.randomUUID(),
				projectId: options.projectId,
				attemptId: options.attemptId,
				sequence: diagSequence,
				stream,
				body: safeBody,
				truncated,
				createdAt: now(),
			};
			store.diagnostics.push(chunk);
			return chunk;
		},

		async listActivity(opts) {
			const limit = opts?.limit ?? 20;
			const cursor = opts?.cursor;
			let startIdx = 0;
			if (cursor) {
				const cursorIdx = store.activity.findIndex((e) => e.id === cursor);
				if (cursorIdx >= 0) startIdx = cursorIdx + 1;
			}
			const items = store.activity.slice(startIdx, startIdx + limit);
			const nextCursor =
				items.length === limit && startIdx + limit < store.activity.length
					? (items[items.length - 1]?.id ?? null)
					: null;
			return { items, nextCursor };
		},

		async getLatestSnapshot() {
			const filtered = store.snapshots.filter((s) => s.attemptId === options.attemptId);
			if (filtered.length === 0) return null;
			return filtered.reduce((a, b) => (a.sourceVersion > b.sourceVersion ? a : b));
		},
	};
}
