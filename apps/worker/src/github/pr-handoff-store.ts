/**
 * PostgreSQL-backed PRHandoffStore used by the production GitHub runtime.
 */
import {
	appendActivityEvent,
	appendAuditEvent,
	appendFailureRecord,
	createOutboxIntent,
	createPullRequestIdentity,
	getDevelopmentAttempt,
	getFeatureById,
	getProjectById,
	getTaskApprovalById,
	type Queryable,
} from "../../../../packages/database/src/index";
import {
	applyFeatureTransition,
	type FeatureState,
	type TransitionOwner,
} from "../../../../packages/domain/src/index";
import type { PRHandoffStore } from "./pr-handoff-worker";

export function createPostgresPrHandoffStore(
	sql: Queryable,
	now: () => Date = () => new Date(),
): PRHandoffStore {
	return {
		async loadHandoffContext(attemptId) {
			const attempt = await getDevelopmentAttempt(sql, attemptId);
			if (!attempt) return null;
			const [project, feature, approval] = await Promise.all([
				getProjectById(sql, attempt.projectId),
				getFeatureById(sql, attempt.featureId),
				getTaskApprovalById(sql, attempt.taskApprovalId),
			]);
			if (!project || !feature || !approval) return null;
			return {
				attempt: {
					id: attempt.id,
					projectId: attempt.projectId,
					featureId: attempt.featureId,
					branchName: attempt.branchName,
					taskApprovalId: attempt.taskApprovalId,
				},
				project: {
					id: project.id,
					githubOwner: project.githubOwner,
					githubRepo: project.githubRepo,
					canonicalPath: project.canonicalPath,
					developmentBranch: project.developmentBranch,
				},
				feature: {
					id: feature.id,
					projectId: feature.projectId,
					state: feature.state,
					branchName: feature.branchName,
					slug: feature.slug,
					title: feature.title,
					rowVersion: feature.rowVersion,
				},
				approval: {
					id: approval.id,
					checksum: approval.checksum,
				},
			};
		},
		async getExistingPRByFeature(featureId) {
			const rows = await sql`
				SELECT id, number, url, head_branch, base_branch, original_head_sha
				FROM pull_requests
				WHERE feature_id = ${featureId}
				LIMIT 1
			`;
			const row = rows[0];
			if (!row) return null;
			return {
				id: row.id as string,
				number: row.number as number,
				url: row.url as string,
				headBranch: row.head_branch as string,
				baseBranch: row.base_branch as string,
				originalHeadSha: row.original_head_sha as string,
			};
		},
		async persistPRIdentity(featureId, input) {
			const pr = await createPullRequestIdentity(sql, {
				projectId: input.projectId,
				featureId,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				number: input.number,
				url: input.url,
				headBranch: input.headBranch,
				baseBranch: input.baseBranch,
				originalHeadSha: input.originalHeadSha,
			});
			return {
				id: pr.id,
				number: pr.number,
				url: pr.url,
				headBranch: pr.headBranch,
				baseBranch: pr.baseBranch,
				originalHeadSha: pr.originalHeadSha,
			};
		},
		async transitionFeature(featureId, input) {
			return transitionFeatureInStore(sql, featureId, input, now);
		},
		async recordActivity(input) {
			await appendActivityEvent(sql, {
				projectId: input.projectId,
				featureId: input.featureId,
				attemptId: input.attemptId,
				type: input.type,
				summary: input.summary,
				source: "worker",
				metadata: input.metadata,
			});
		},
		async recordAudit(input) {
			await appendAuditEvent(sql, {
				actorType: "worker",
				actorId: input.actor,
				action: input.action,
				targetType: "feature",
				targetId: input.target,
				projectId: input.projectId,
				result: "success",
				priorValues: input.prior ?? null,
				nextValues: input.next ?? null,
			});
		},
		async createOutboxIntent(input) {
			await createOutboxIntent(sql, {
				projectId: input.projectId,
				featureId: input.featureId,
				kind: input.kind,
				dedupeKey: input.dedupeKey,
				payload: input.payload,
			});
		},
		async persistFailure(input) {
			const feature = await getFeatureById(sql, input.featureId);
			if (!feature) return;
			await transitionFeatureInStore(
				sql,
				input.featureId,
				{
					from: feature.state,
					to: input.targetState,
					owner: "github_adapter",
					operationId: `pr-fail:${input.featureId}:${input.targetState}`,
				},
				now,
			);
			await appendFailureRecord(sql, {
				projectId: feature.projectId,
				featureId: input.featureId,
				category: "github",
				summary: input.reason,
				recommendedAction: "Retry PR creation after inspecting the failure.",
				details: { activityType: input.activityType },
			});
		},
		async checkIdempotency(operationKey) {
			const rows = await sql`
				SELECT result
				FROM idempotency_records
				WHERE operation_key = ${operationKey}
				LIMIT 1
			`;
			return rows[0]?.result ?? null;
		},
		async recordIdempotency(operationKey, result) {
			const attemptId = operationKey.startsWith("pr-handoff:")
				? operationKey.slice("pr-handoff:".length)
				: null;
			const attempt = attemptId ? await getDevelopmentAttempt(sql, attemptId) : null;
			if (!attempt) return;
			await sql`
				INSERT INTO idempotency_records (operation_key, project_id, feature_id, attempt_id, result)
				VALUES (
					${operationKey},
					${attempt.projectId},
					${attempt.featureId},
					${attempt.id},
					${sql.json(result as never)}
				)
				ON CONFLICT (operation_key) DO NOTHING
			`;
		},
	};
}

async function transitionFeatureInStore(
	sql: Queryable,
	featureId: string,
	input: { from: string; to: string; owner: string; operationId: string },
	now: () => Date,
): Promise<{ kind: "applied" } | { kind: "rejected"; reason: string }> {
	const feature = await getFeatureById(sql, featureId);
	if (!feature) return { kind: "rejected", reason: "feature not found" };
	const transition = applyFeatureTransition(
		{
			featureId,
			from: input.from as FeatureState,
			to: input.to as FeatureState,
			owner: input.owner as TransitionOwner,
			cause: input.operationId,
			operationId: input.operationId,
			expectedVersion: feature.rowVersion,
			currentVersion: feature.rowVersion,
			observedState: feature.state,
		},
		{ now },
	);
	if (transition.kind !== "applied") {
		return {
			kind: "rejected",
			reason:
				transition.kind === "rejected"
					? transition.message
					: `idempotent operation ${input.operationId}`,
		};
	}
	const rows = await sql`
		UPDATE features
		SET state = ${transition.nextState},
			row_version = ${transition.nextVersion},
			updated_at = now()
		WHERE id = ${featureId}
			AND state = ${transition.priorState}
			AND row_version = ${transition.priorVersion}
		RETURNING id
	`;
	if (!rows[0]) return { kind: "rejected", reason: "feature transition conflict" };
	return { kind: "applied" };
}

export { transitionFeatureInStore };
