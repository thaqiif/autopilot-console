import { describe, expect, test } from "bun:test";
import type { Queryable } from "../../../../packages/database/src/client";
import { queryFeatureDetail } from "./feature-detail-query";
import { queryOverview } from "./overview-query";

const featureId = "00000000-0000-4000-8000-000000000023";
const projectId = "00000000-0000-4000-8000-000000000001";
const releaseId = "00000000-0000-4000-8000-000000000002";
const attemptId = "00000000-0000-4000-8000-000000000003";

describe("persisted read projections", () => {
	test("overview is rebuilt in one query from authoritative persisted statuses", async () => {
		let calls = 0;
		const sql = (async (strings: TemplateStringsArray) => {
			calls += 1;
			const query = strings.join("?");
			expect(query).toContain("failure_records");
			expect(query).toContain("r.status = 'DEVELOPMENT_MERGED'");
			return [
				{
					project_count: 10,
					active_jobs: 4,
					queued_jobs: 3,
					attention_count: 6,
					failed_jobs: 2,
					prs_awaiting_review: 1,
					development_merged_features: 25,
					development_merged_releases: 5,
				},
			];
		}) as unknown as Queryable;

		await expect(queryOverview(sql)).resolves.toEqual({
			projectCount: 10,
			activeJobs: 4,
			queuedJobs: 3,
			attentionCount: 6,
			failedJobs: 2,
			prsAwaitingReview: 1,
			developmentMergedFeatures: 25,
			developmentMergedReleases: 5,
		});
		expect(calls).toBe(1);
	});

	test("feature detail exposes mutable requirement phases and active worker context", async () => {
		const requirements = [
			{
				id: "1",
				description: "Complete",
				passes: true,
				dependsOn: [],
				tdd: {
					test: { passes: true },
					implement: { passes: true },
					refactor: { passes: true },
				},
			},
			{
				id: "2",
				description: "Active",
				passes: false,
				dependsOn: ["1"],
				tdd: {
					test: { passes: true },
					implement: { passes: false },
					refactor: { passes: false },
				},
			},
		];
		const responses: Array<Array<Record<string, unknown>>> = [
			[
				{
					id: featureId,
					project_id: projectId,
					release_id: releaseId,
					slug: "read-projection",
					title: "Read projection",
					summary: null,
					state: "DEVELOPING",
					branch_name: "feature/read-projection",
					task_path: "tasks/read-projection.json",
					row_version: 2,
					created_at: new Date("2026-07-29T19:00:00.000Z"),
					updated_at: new Date("2026-07-29T20:00:00.000Z"),
				},
			],
			[
				{
					id: "approval-1",
					relative_task_path: "tasks/read-projection.json",
					checksum: "checksum",
					requirements_snapshot: { requirements },
					approved_at: new Date("2026-07-29T19:30:00.000Z"),
				},
			],
			[
				{
					summary: { activeRequirementId: "2" },
					requirements,
					created_at: new Date("2026-07-29T20:02:00.000Z"),
				},
			],
			[
				{
					id: attemptId,
					status: "RUNNING",
					branch_name: "feature/read-projection",
					worker_registration_id: "worker-registration-1",
					worker_id: "worker-23",
					worker_hostname: "worker-host",
					worker_capacity: 4,
					process_pid: 2300,
					heartbeat_at: new Date("2026-07-29T20:02:00.000Z"),
					enqueued_at: new Date("2026-07-29T19:59:00.000Z"),
					started_at: new Date("2026-07-29T20:00:00.000Z"),
					ended_at: null,
					exit_code: null,
					structured_result: null,
					predecessor_attempt_id: null,
				},
			],
			[],
			[],
			[],
			[],
		];
		const sql = (async () => responses.shift() ?? []) as unknown as Queryable;

		const detail = await queryFeatureDetail(sql, featureId);
		expect(detail?.progress).toMatchObject({
			totalRequirements: 2,
			passedRequirements: 1,
			activeRequirements: 1,
			remainingRequirements: 1,
			activeRequirementId: "2",
		});
		expect(detail?.progress?.requirements[1]).toMatchObject({
			id: "2",
			dependsOn: ["1"],
			phases: { red: true, green: false, refactor: false },
			status: "in_progress",
		});
		expect(detail?.activeAttempt).toMatchObject({
			id: attemptId,
			worker: {
				workerId: "worker-23",
				hostname: "worker-host",
				capacity: 4,
			},
		});
	});
});
