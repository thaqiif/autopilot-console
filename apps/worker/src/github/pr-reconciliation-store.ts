/**
 * PostgreSQL-backed PRReconciliationStore used by the production GitHub runtime.
 */
import {
	appendActivityEvent,
	appendAuditEvent,
	type Queryable,
} from "../../../../packages/database/src/index";
import { computeBackoff, type GitHubBackoffState } from "./github-backoff";
import { transitionFeatureInStore } from "./pr-handoff-store";
import type { PRReconciliationStore } from "./pr-reconciliation-worker";

export interface PostgresPrReconciliationStoreOptions {
	sql: Queryable;
	now?: () => Date;
	maxConsecutiveErrors?: number;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
}

export function createPostgresPrReconciliationStore(
	options: PostgresPrReconciliationStoreOptions,
): PRReconciliationStore {
	const {
		sql,
		now = () => new Date(),
		maxConsecutiveErrors = 5,
		baseBackoffMs = 30_000,
		maxBackoffMs = 600_000,
	} = options;

	const backoffByFeature = new Map<string, GitHubBackoffState>();

	function stateFor(featureId: string): GitHubBackoffState {
		const existing = backoffByFeature.get(featureId);
		if (existing) return existing;
		const created: GitHubBackoffState = {
			featureId,
			consecutiveErrors: 0,
			lastError: null,
			lastErrorAt: null,
			backoffUntil: null,
		};
		backoffByFeature.set(featureId, created);
		return created;
	}

	return {
		async listOpenPRs() {
			const rows = await sql`
				SELECT
					pr.feature_id,
					pr.project_id,
					pr.number,
					pr.url,
					pr.head_branch,
					pr.base_branch,
					pr.original_head_sha,
					pr.observed_head_sha,
					pr.observed_state,
					pr.last_observed_at,
					f.state AS feature_state
				FROM pull_requests pr
				INNER JOIN features f ON f.id = pr.feature_id
				WHERE pr.observed_state IS DISTINCT FROM 'merged'
					AND f.state NOT IN ('DEVELOPMENT_MERGED', 'BLOCKED')
			`;
			return rows.map((row) => ({
				featureId: row.feature_id as string,
				projectId: row.project_id as string,
				prNumber: row.number as number,
				url: row.url as string,
				headBranch: row.head_branch as string,
				baseBranch: row.base_branch as string,
				originalHeadSha: row.original_head_sha as string,
				observedHeadSha: (row.observed_head_sha as string | null) ?? null,
				observedState: (row.observed_state as string | null) ?? null,
				featureState: row.feature_state as string,
				lastObservedAt: (row.last_observed_at as Date | null) ?? null,
			}));
		},
		async updatePRObservation(featureId, input) {
			// Monotonic: only apply when observation is newer than last_observed_at.
			await sql`
				UPDATE pull_requests
				SET
					observed_head_sha = ${input.observedHeadSha},
					observed_state = ${input.observedState},
					last_observed_at = ${input.lastObservedAt},
					updated_at = now()
				WHERE feature_id = ${featureId}
					AND (last_observed_at IS NULL OR last_observed_at < ${input.lastObservedAt})
			`;
		},
		async transitionFeature(featureId, input) {
			return transitionFeatureInStore(sql, featureId, input, now);
		},
		async recordActivity(input) {
			await appendActivityEvent(sql, {
				projectId: input.projectId,
				featureId: input.featureId,
				type: input.type,
				summary: input.summary,
				source: "github_poller",
				metadata: input.metadata,
			});
		},
		async recordAudit(input) {
			await appendAuditEvent(sql, {
				actorType: "github_poller",
				actorId: input.actor,
				action: input.action,
				targetType: "feature",
				targetId: input.target,
				projectId: input.projectId,
				result: "success",
			});
		},
		async recordBackoff(featureId, error) {
			const state = stateFor(featureId);
			state.consecutiveErrors += 1;
			state.lastError = error;
			state.lastErrorAt = now();
			const computed = computeBackoff(state, {
				maxConsecutiveErrors,
				baseBackoffMs,
				maxBackoffMs,
				now,
			});
			if (computed.backoffMs > 0) {
				state.backoffUntil = new Date(now().getTime() + computed.backoffMs);
			}
		},
		async shouldBackoff(featureId) {
			const state = stateFor(featureId);
			const computed = computeBackoff(state, {
				maxConsecutiveErrors,
				baseBackoffMs,
				maxBackoffMs,
				now,
			});
			return computed.shouldBackoff;
		},
	};
}
