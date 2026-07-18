import { describe, expect, test } from "bun:test";
import type {
	DevelopmentAttemptRow,
	FeatureRow,
	ProjectRow,
	TaskApprovalRow,
} from "../../../../packages/database/src/index";

import type { RetryOutcome, RetryRequest, RetryService } from "./retry-service";

// ---------------------------------------------------------------------------
// Shared test clock
// ---------------------------------------------------------------------------
const NOW = new Date("2026-07-18T16:00:00.000Z");

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface RetrySeed {
	attempt: DevelopmentAttemptRow;
	feature: FeatureRow;
	project: ProjectRow;
	approval: TaskApprovalRow;
}

function attemptSeed(
	options: {
		status?: "FAILED" | "INTERRUPTED" | "CANCELLED" | "QUEUED";
		featureState?: FeatureRow["state"];
		predecessorId?: string | null;
		processActive?: boolean;
		sameBranch?: boolean;
	} = {},
): RetrySeed {
	const projectId = crypto.randomUUID();
	const featureId = crypto.randomUUID();
	const attemptId = crypto.randomUUID();
	const branch =
		options.sameBranch !== false ? `feature/${featureId}-login` : "feature/wrong-branch";

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
		state: options.featureState ?? "DEVELOPMENT_FAILED",
		branchName: `feature/${featureId}-login`,
		taskPath: "docs/tasks/login.json",
		rowVersion: 8,
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
		status: options.status ?? "FAILED",
		predecessorAttemptId: options.predecessorId ?? null,
		workerRegistrationId: null,
		processPid: options.processActive ? 9999 : null,
		processStartIdentity: options.processActive ? "987_654" : null,
		leaseExpiresAt: null,
		heartbeatAt: null,
		enqueuedAt: NOW,
		startedAt: NOW,
		endedAt: new Date(NOW.getTime() + 10_000),
		exitCode: 1,
		cancellationRequestedAt: options.status === "CANCELLED" ? NOW : null,
		cancellationReason: options.status === "CANCELLED" ? "user request" : null,
		structuredResult: { outcome: "failed" },
		createdAt: NOW,
		updatedAt: NOW,
	};

	const approval: TaskApprovalRow = {
		id: attempt.taskApprovalId,
		projectId,
		featureId,
		relativeTaskPath: feature.taskPath ?? "",
		checksum: "sha256:approved",
		schemaCompatibilityVersion: "1",
		requirementsSnapshot: { requirements: [] },
		approvedByAdminId: crypto.randomUUID(),
		approvedAt: NOW,
		invalidatedAt: null,
		createdAt: NOW,
	};

	return { attempt, feature, project, approval };
}

// ---------------------------------------------------------------------------
// Fake persistence
// ---------------------------------------------------------------------------

interface RetryPersistence {
	idempotencyMap: Map<string, DevelopmentAttemptRow>;
	created: DevelopmentAttemptRow[];
	getLatestAttempt(featureId: string): Promise<DevelopmentAttemptRow | null>;
	getFeature(featureId: string): Promise<FeatureRow | null>;
	isAnyProcessActive(featureId: string): Promise<boolean>;
	createRetryAttempt(input: {
		projectId: string;
		featureId: string;
		taskApprovalId: string;
		branchName: string;
		operationKey: string;
		predecessorAttemptId: string;
	}): Promise<DevelopmentAttemptRow>;
	checkIdempotency(operationKey: string): Promise<DevelopmentAttemptRow | null>;
}

function retryPersistence(seed: RetrySeed): RetryPersistence {
	const idempotencyMap = new Map<string, DevelopmentAttemptRow>();
	const created: DevelopmentAttemptRow[] = [];
	return {
		idempotencyMap,
		created,
		async getLatestAttempt(featureId: string) {
			if (featureId === seed.feature.id) return structuredClone(seed.attempt);
			return null;
		},
		async getFeature(featureId: string) {
			if (featureId === seed.feature.id) return structuredClone(seed.feature);
			return null;
		},
		async isAnyProcessActive() {
			return seed.attempt.processPid !== null;
		},
		async createRetryAttempt(input) {
			const newAttempt: DevelopmentAttemptRow = {
				id: crypto.randomUUID(),
				projectId: input.projectId,
				featureId: input.featureId,
				taskApprovalId: input.taskApprovalId,
				branchName: input.branchName,
				operationKey: input.operationKey,
				status: "QUEUED",
				predecessorAttemptId: input.predecessorAttemptId,
				workerRegistrationId: null,
				processPid: null,
				processStartIdentity: null,
				leaseExpiresAt: null,
				heartbeatAt: null,
				enqueuedAt: NOW,
				startedAt: null,
				endedAt: null,
				exitCode: null,
				cancellationRequestedAt: null,
				cancellationReason: null,
				structuredResult: null,
				createdAt: NOW,
				updatedAt: NOW,
			};
			created.push(newAttempt);
			idempotencyMap.set(input.operationKey, newAttempt);
			return newAttempt;
		},
		async checkIdempotency(operationKey: string) {
			return idempotencyMap.get(operationKey) ?? null;
		},
	};
}

/**
 * In-memory reference implementation of RetryService.
 * ponytail: Delete after createRetryService exists in retry-service.ts.
 * Tests are written against the RetryService interface so they validate
 * the same contract the production code must satisfy.
 */
class InMemoryRetryService implements RetryService {
	constructor(private store: RetryPersistence) {}

	async retry(request: RetryRequest): Promise<RetryOutcome> {
		const prior = await this.store.checkIdempotency(request.operationKey);
		if (prior) return { kind: "idempotent", attempt: prior };

		const feature = await this.store.getFeature(request.featureId);
		if (!feature) return { kind: "blocked", reason: "Feature not found." };

		const RETRYABLE_FEATURE_STATES: FeatureRow["state"][] = [
			"DEVELOPMENT_FAILED",
			"DEVELOPMENT_INTERRUPTED",
			"DEVELOPMENT_CANCELLED",
		];
		if (!RETRYABLE_FEATURE_STATES.includes(feature.state)) {
			return {
				kind: "blocked",
				reason: `Feature state ${feature.state} is not retryable.`,
			};
		}

		const latest = await this.store.getLatestAttempt(request.featureId);
		if (!latest) return { kind: "blocked", reason: "No existing attempt found." };

		const RETRYABLE_STATUSES = ["FAILED", "INTERRUPTED", "CANCELLED"] as const;
		if (!RETRYABLE_STATUSES.includes(latest.status as (typeof RETRYABLE_STATUSES)[number])) {
			return {
				kind: "blocked",
				reason: `Attempt status ${latest.status} is not retryable.`,
			};
		}

		if (latest.branchName !== feature.branchName) {
			return {
				kind: "blocked",
				reason: "Branch mismatch between attempt and feature.",
			};
		}

		// Liveness check: if process identity exists, verify it's gone
		if (latest.processPid !== null && latest.processStartIdentity !== null) {
			const processActive = await this.store.isAnyProcessActive(request.featureId);
			if (processActive) {
				return {
					kind: "blocked",
					reason: "Process may still be active; retry is unsafe.",
				};
			}
		}

		const retryAttempt = await this.store.createRetryAttempt({
			projectId: request.projectId,
			featureId: request.featureId,
			taskApprovalId: request.taskApprovalId,
			branchName: feature.branchName,
			operationKey: request.operationKey,
			predecessorAttemptId: latest.id,
		});

		return { kind: "retried", attempt: retryAttempt };
	}
}

function makeRetry(seed: RetrySeed): {
	service: RetryService;
	store: RetryPersistence;
} {
	const store = retryPersistence(seed);
	return { service: new InMemoryRetryService(store), store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retry service", () => {
	test("retries FAILED attempt — new QUEUED attempt linked via predecessor", async () => {
		const seed = attemptSeed({ status: "FAILED", featureState: "DEVELOPMENT_FAILED" });
		const { service, store } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:1",
			reason: "Fix applied",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("retried");
		if (outcome.kind === "retried") {
			expect(outcome.attempt.status).toBe("QUEUED");
			expect(outcome.attempt.predecessorAttemptId).toBe(seed.attempt.id);
			expect(outcome.attempt.branchName).toBe(seed.feature.branchName);
			expect(outcome.attempt.projectId).toBe(seed.project.id);
			expect(outcome.attempt.featureId).toBe(seed.feature.id);
		}
		expect(store.created).toHaveLength(1);
		expect(seed.attempt.status).toBe("FAILED");
	});

	test("retries INTERRUPTED attempt", async () => {
		const seed = attemptSeed({
			status: "INTERRUPTED",
			featureState: "DEVELOPMENT_INTERRUPTED",
		});
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:int",
			reason: "Resume",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("retried");
	});

	test("retries CANCELLED attempt", async () => {
		const seed = attemptSeed({
			status: "CANCELLED",
			featureState: "DEVELOPMENT_CANCELLED",
		});
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:cxl",
			reason: "Re-queue",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("retried");
	});

	test("blocks retry when process may still be active", async () => {
		const seed = attemptSeed({
			status: "FAILED",
			featureState: "DEVELOPMENT_FAILED",
			processActive: true,
		});
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:live",
			reason: "Try",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("blocked");
	});

	test("allows retry when no process identity recorded (process verified gone)", async () => {
		const seed = attemptSeed({
			status: "FAILED",
			featureState: "DEVELOPMENT_FAILED",
			processActive: false,
		});
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:noproc",
			reason: "Retry",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("retried");
	});

	test("blocks retry for non-retryable feature states", async () => {
		const seed = attemptSeed({ status: "QUEUED", featureState: "QUEUED" });
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:queued",
			reason: "Nope",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("blocked");
	});

	test("blocks retry for non-retryable attempt status (SUCCEEDED)", async () => {
		const seed = attemptSeed({ status: "FAILED", featureState: "DEVELOPMENT_FAILED" });
		seed.attempt.status = "SUCCEEDED";
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:done",
			reason: "Nope",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("blocked");
	});

	test("new attempt reuses the same feature branch for resume", async () => {
		const seed = attemptSeed({
			status: "INTERRUPTED",
			featureState: "DEVELOPMENT_INTERRUPTED",
		});
		const { service, store } = makeRetry(seed);

		await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:branch",
			reason: "",
			actorId: "admin-1",
		});

		expect(store.created[0]?.branchName).toBe(seed.feature.branchName);
		expect(store.created[0]?.branchName).toBe(seed.attempt.branchName);
	});

	test("duplicate retry is idempotent", async () => {
		const seed = attemptSeed({ status: "FAILED", featureState: "DEVELOPMENT_FAILED" });
		const { service, store } = makeRetry(seed);

		await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:dup",
			reason: "First",
			actorId: "admin-1",
		});
		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:dup",
			reason: "Second",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("idempotent");
		expect(store.created).toHaveLength(1);
	});

	test("all prior attempts and evidence are preserved on retry", async () => {
		const seed = attemptSeed({ status: "FAILED", featureState: "DEVELOPMENT_FAILED" });
		const { service } = makeRetry(seed);

		await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:evidence",
			reason: "",
			actorId: "admin-1",
		});

		expect(seed.attempt.status).toBe("FAILED");
		expect(seed.attempt.exitCode).toBe(1);
		expect(seed.attempt.structuredResult).toEqual({ outcome: "failed" });
	});

	test("blocks when branch mismatch between attempt and feature", async () => {
		const seed = attemptSeed({
			status: "FAILED",
			featureState: "DEVELOPMENT_FAILED",
			sameBranch: false,
		});
		const { service } = makeRetry(seed);

		const outcome = await service.retry({
			featureId: seed.feature.id,
			projectId: seed.project.id,
			taskApprovalId: seed.approval.id,
			branchName: seed.feature.branchName,
			operationKey: "retry:mismatch",
			reason: "",
			actorId: "admin-1",
		});

		expect(outcome.kind).toBe("blocked");
	});
});
