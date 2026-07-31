import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useSseRestRefresh } from "../../api/use-sse-rest-refresh";
import { useAuth } from "../../auth/auth-provider";
import { ViewState } from "../../components/feedback/view-state";
import type { AttemptRecord } from "../jobs/attempt-history";
import { AttemptHistory } from "../jobs/attempt-history";
import { DiagnosticLogExcerpt } from "../jobs/diagnostic-log-excerpt";
import { FailureDetail } from "../jobs/failure-detail";
import { JobActions } from "../jobs/job-actions";
import type { RequirementProgress } from "../jobs/job-progress";
import { JobProgress } from "../jobs/job-progress";
import { PullRequestStatus } from "../pull-requests/pull-request-status";
import type { RequirementSummary } from "../tasks/requirement-card";
import { TaskAttachmentForm } from "../tasks/task-attachment-form";
import { TaskReview } from "../tasks/task-review";

interface TaskSnapshot {
	name: string;
	description: string;
	goals: string[];
	nonGoals: string[];
	requirements: RequirementSummary[];
	checksum: string;
	rawJson?: string;
}

interface ApiTaskSummary {
	name?: string;
	description?: string;
	goals?: string[];
	nonGoals?: string[];
	requirements?: unknown[];
	rawJson?: string;
}

interface FeatureDetail {
	id: string;
	projectId: string;
	releaseId: string;
	slug: string;
	title: string;
	summary: string | null;
	state: string;
	branchName: string;
	taskPath: string | null;
	rowVersion: number;
	taskApproval: {
		id: string;
		relativeTaskPath: string;
		checksum: string;
		requirementsSnapshot: unknown;
		approvedAt: string;
	} | null;
	progress: {
		totalRequirements: number;
		passedRequirements: number;
		activeRequirements: number;
		stuckRequirements: number;
		invalidRequirements: number;
		remainingRequirements: number;
		activeRequirementId?: string | null;
		requirements?: unknown[];
		lastUpdatedAt: string | null;
	} | null;
	activeAttempt?: {
		id: string;
		status: string;
		workerRegistrationId: string | null;
		worker?: {
			workerId: string;
			hostname: string;
			capacity: number;
			activeJobs: number;
			lastHeartbeatAt: string;
		} | null;
		heartbeatAt: string | null;
		enqueuedAt: string;
		startedAt: string | null;
		endedAt: string | null;
		exitCode: number | null;
		structuredResult: unknown | null;
		predecessorAttemptId?: string | null;
	} | null;
	attempts: Array<{
		id: string;
		status: string;
		workerRegistrationId: string | null;
		worker?: {
			workerId: string;
			hostname: string;
			capacity: number;
			activeJobs: number;
			lastHeartbeatAt: string;
		} | null;
		heartbeatAt: string | null;
		enqueuedAt: string;
		startedAt: string | null;
		endedAt: string | null;
		exitCode: number | null;
		structuredResult: unknown | null;
		predecessorAttemptId?: string | null;
	}>;
	failures: Array<{
		id: string;
		attemptId: string | null;
		category: string;
		summary: string;
		recommendedAction: string;
		occurredAt: string;
	}>;
	diagnosticLogs: Array<{ id: string; body: string; truncated?: boolean }>;
	pullRequest: {
		number: number;
		url: string;
		observedState: string | null;
		observedHeadSha: string | null;
		mergeCommitSha: string | null;
		lastObservedAt: string | null;
	} | null;
	recentActivity: Array<{ id: string; type: string; summary: string; occurredAt: string }>;
}

interface AttachTaskResponse {
	feature: Partial<FeatureDetail>;
	summary: ApiTaskSummary;
	checksum: string;
}

interface ApproveQueueResponse {
	feature?: Partial<FeatureDetail>;
	approval?: FeatureDetail["taskApproval"];
	attempt?: { id: string };
	idempotent?: boolean;
}

interface ReplaceTaskResponse {
	feature?: Partial<FeatureDetail>;
	summary?: ApiTaskSummary;
	checksum?: string;
}

interface ProjectSummary {
	id: string;
	name: string;
}

type PageState = "loading" | "ready" | "error";

const JOB_STATES = new Set([
	"QUEUED",
	"DEVELOPING",
	"RUNNING",
	"DEVELOPMENT_COMPLETE",
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
	"PR_CREATING",
	"PR_CREATION_FAILED",
	"CI_RUNNING",
	"CI_FAILED",
	"PR_REVIEW",
	"PR_CHANGES_REQUESTED",
	"DEVELOPMENT_MERGED",
]);

const PR_STATES = new Set([
	"PR_CREATING",
	"PR_CREATION_FAILED",
	"CI_RUNNING",
	"CI_FAILED",
	"PR_REVIEW",
	"PR_CHANGES_REQUESTED",
	"DEVELOPMENT_MERGED",
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function phaseComplete(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	return asRecord(value).passes === true;
}

function mapRequirement(value: unknown, index: number): RequirementSummary {
	const requirement = asRecord(value);
	const tdd = asRecord(requirement.tdd);
	const phases = asRecord(requirement.phases);
	const passes = requirement.passes === true;
	const stuck = requirement.stuck === true;
	const invalidTest = requirement.invalidTest === true;
	const status = passes
		? "passed"
		: stuck
			? "stuck"
			: invalidTest
				? "invalid"
				: requirement.status === "in_progress"
					? "in_progress"
					: "not_started";
	return {
		id: String(requirement.id ?? index + 1),
		description: String(requirement.description ?? ""),
		status,
		passes,
		stuck,
		stuckReason: typeof requirement.stuckReason === "string" ? requirement.stuckReason : undefined,
		invalidTest,
		invalidTestReason:
			typeof requirement.invalidTestReason === "string" ? requirement.invalidTestReason : undefined,
		blockedReason:
			typeof requirement.blockedReason === "string" ? requirement.blockedReason : undefined,
		dependsOn: Array.isArray(requirement.dependsOn) ? requirement.dependsOn.map(String) : [],
		acceptance: Array.isArray(requirement.acceptance) ? requirement.acceptance.map(String) : [],
		redPhase: phaseComplete(requirement.redPhase ?? phases.red ?? tdd.test),
		greenPhase: phaseComplete(requirement.greenPhase ?? phases.green ?? tdd.implement),
		refactorPhase: phaseComplete(requirement.refactorPhase ?? phases.refactor ?? tdd.refactor),
	};
}

function mapProgressRequirements(values: unknown[] | undefined): RequirementProgress[] {
	return (values ?? []).map((value, index) => {
		const summary = mapRequirement(value, index);
		return {
			...summary,
			dependsOn: summary.dependsOn,
			acceptance: summary.acceptance,
		};
	});
}

function elapsedFrom(
	startTime: string | null | undefined,
	endTime?: string | null,
): number | undefined {
	if (!startTime) return undefined;
	const start = new Date(startTime).getTime();
	if (Number.isNaN(start)) return undefined;
	const end = endTime ? new Date(endTime).getTime() : Date.now();
	if (Number.isNaN(end) || end < start) return undefined;
	return end - start;
}

function mapTaskSummary(summary: ApiTaskSummary, checksum: string): TaskSnapshot {
	return {
		name: summary.name ?? "Task review",
		description: summary.description ?? "",
		goals: summary.goals ?? [],
		nonGoals: summary.nonGoals ?? [],
		requirements: (summary.requirements ?? []).map(mapRequirement),
		checksum,
		rawJson: summary.rawJson,
	};
}

function taskFromApproval(feature: FeatureDetail): TaskSnapshot | null {
	if (!feature.taskApproval) return null;
	const snapshot = feature.taskApproval.requirementsSnapshot;
	const requirements = Array.isArray(snapshot)
		? snapshot
		: Array.isArray(asRecord(snapshot).requirements)
			? (asRecord(snapshot).requirements as unknown[])
			: [];
	return mapTaskSummary(
		{
			name: feature.title,
			description: feature.summary ?? "",
			requirements,
		},
		feature.taskApproval.checksum,
	);
}

function resultSummary(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	const summary = asRecord(value).summary;
	if (typeof summary === "string") return summary;
	return typeof value === "string" ? value : JSON.stringify(value);
}

function isStaleChecksumError(error: { code?: string; message?: string }): boolean {
	const code = (error.code ?? "").toUpperCase();
	const message = (error.message ?? "").toLowerCase();
	return (
		code === "STALE_CHECKSUM" ||
		code === "CONFLICT" ||
		message.includes("checksum") ||
		message.includes("changed") ||
		message.includes("stale")
	);
}

function deriveCiStatus(state: string): "PENDING" | "PASSING" | "FAILING" | "NONE" {
	switch (state) {
		case "CI_RUNNING":
			return "PENDING";
		case "CI_FAILED":
			return "FAILING";
		case "PR_REVIEW":
		case "PR_CHANGES_REQUESTED":
		case "DEVELOPMENT_COMPLETE":
		case "DEVELOPMENT_MERGED":
			return "PASSING";
		default:
			return "NONE";
	}
}

function deriveReviewDecision(
	state: string,
): "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE" {
	switch (state) {
		case "PR_REVIEW":
			return "REVIEW_REQUIRED";
		case "PR_CHANGES_REQUESTED":
			return "CHANGES_REQUESTED";
		case "DEVELOPMENT_MERGED":
			return "APPROVED";
		default:
			return "NONE";
	}
}

function isStalePullRequest(lastObservedAt: string | null): boolean {
	if (!lastObservedAt) return false;
	const age = Date.now() - new Date(lastObservedAt).getTime();
	return age > 5 * 60 * 1000;
}

export function FeatureDetailPage() {
	const { id } = useParams<{ id: string }>();
	const { client } = useAuth();
	const [feature, setFeature] = useState<FeatureDetail | null>(null);
	const [projectName, setProjectName] = useState<string>("");
	const [task, setTask] = useState<TaskSnapshot | null>(null);
	const [pageState, setPageState] = useState<PageState>("loading");
	const [attachError, setAttachError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [isAttaching, setIsAttaching] = useState(false);
	const [isApproving, setIsApproving] = useState(false);
	const [isCancelling, setIsCancelling] = useState(false);
	const [isRetrying, setIsRetrying] = useState(false);
	const [isPrRetrying, setIsPrRetrying] = useState(false);
	const [staleChecksum, setStaleChecksum] = useState(false);
	const [isLiveStale, setIsLiveStale] = useState(false);

	const loadFeature = useCallback(async () => {
		const result = await client.get<FeatureDetail>(`/api/features/${id}`);
		if (!result.ok) {
			setPageState("error");
			return false;
		}

		const project = await client.get<ProjectSummary>(`/api/projects/${result.data.projectId}`);
		setProjectName(project.ok ? project.data.name : result.data.projectId);
		setFeature(result.data);
		setTask((current) => current ?? taskFromApproval(result.data));
		setIsLiveStale(false);
		setPageState("ready");
		return true;
	}, [client, id]);

	useEffect(() => {
		void loadFeature();
	}, [loadFeature]);

	useSseRestRefresh(loadFeature, {
		onStale: () => setIsLiveStale(true),
	});

	async function attachTask(taskPath: string) {
		const result = await client.post<AttachTaskResponse>(`/api/features/${id}/task`, {
			relativeTaskPath: taskPath,
		});
		if (!result.ok) {
			setAttachError(result.error.message);
			return false;
		}
		setFeature((current) => (current ? { ...current, ...result.data.feature } : current));
		setTask(mapTaskSummary(result.data.summary, result.data.checksum));
		setAttachError(null);
		setStaleChecksum(false);
		return true;
	}

	async function handleAttachTask(taskPath: string) {
		setIsAttaching(true);
		await attachTask(taskPath);
		setIsAttaching(false);
	}

	async function handleApprove() {
		if (!task || !feature) return;
		setIsApproving(true);
		setActionError(null);
		const operationKey = client.generateOperationKey({
			operation: "feature.approve-queue",
			projectId: feature.projectId,
			featureId: feature.id,
		});
		const result = await client.post<ApproveQueueResponse>(`/api/features/${id}/approve-queue`, {
			projectId: feature.projectId,
			featureId: feature.id,
			displayedChecksum: task.checksum,
			operationKey,
			confirmation: "approve-and-queue",
		});
		setIsApproving(false);
		if (!result.ok) {
			setActionError(result.error.message);
			setStaleChecksum(isStaleChecksumError(result.error));
			return;
		}
		setStaleChecksum(false);
		if (result.data.feature) {
			setFeature((current) => (current ? { ...current, ...result.data.feature } : current));
		}
		await loadFeature();
	}

	async function handleRemove() {
		if (!feature) return;
		setActionError(null);
		const result = await client.del<Partial<FeatureDetail>>(`/api/features/${id}/task`);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		setTask(null);
		setFeature((current) =>
			current ? { ...current, ...result.data, taskPath: result.data.taskPath ?? null } : current,
		);
	}

	async function handleInvalidate() {
		if (!feature?.taskApproval) {
			setActionError("No active task approval is available to invalidate.");
			return;
		}
		setActionError(null);
		const operationKey = client.generateOperationKey({
			operation: "task.approval.invalidate",
			projectId: feature.projectId,
			featureId: feature.id,
		});
		const result = await client.post(
			`/api/features/${feature.id}/approvals/${feature.taskApproval.id}/invalidate`,
			{
				projectId: feature.projectId,
				featureId: feature.id,
				confirmation: "invalidate-task-approval",
				operationKey,
			},
		);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		setTask(null);
		await loadFeature();
	}

	async function handleReplace(taskPath: string) {
		if (!feature) return;
		if (!feature.taskApproval) {
			await handleAttachTask(taskPath);
			return;
		}
		setActionError(null);
		setIsAttaching(true);
		const operationKey = client.generateOperationKey({
			operation: "task.replace",
			projectId: feature.projectId,
			featureId: feature.id,
		});
		const result = await client.put<ReplaceTaskResponse>(`/api/features/${feature.id}/task`, {
			projectId: feature.projectId,
			featureId: feature.id,
			approvalId: feature.taskApproval.id,
			relativeTaskPath: taskPath,
			operationKey,
			confirmation: "replace-task",
		});
		setIsAttaching(false);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		if (result.data.feature) {
			setFeature((current) => (current ? { ...current, ...result.data.feature } : current));
		}
		if (result.data.summary && result.data.checksum) {
			setTask(mapTaskSummary(result.data.summary, result.data.checksum));
		}
		setStaleChecksum(false);
		await loadFeature();
	}

	async function handleRefresh() {
		if (!feature?.taskPath) return;
		setIsAttaching(true);
		await attachTask(feature.taskPath);
		setIsAttaching(false);
	}

	async function handleCancel() {
		setIsCancelling(true);
		setActionError(null);
		const result = await client.post(`/api/features/${id}/cancel`, {
			reason: "user requested",
			confirmation: "cancel-development",
		});
		setIsCancelling(false);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		await loadFeature();
	}

	async function handleRetry() {
		if (!feature) return;
		setIsRetrying(true);
		setActionError(null);
		const operationKey = client.generateOperationKey({
			operation: "feature.retry",
			projectId: feature.projectId,
			featureId: feature.id,
		});
		const result = await client.post(`/api/features/${id}/retry`, {
			operationKey,
			confirmation: "retry-development",
			reason: "explicit retry",
		});
		setIsRetrying(false);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		await loadFeature();
	}

	async function handlePrRetry() {
		const attemptId = feature?.attempts[0]?.id;
		if (!attemptId) {
			setActionError("No development attempt is available for PR retry.");
			return;
		}
		setIsPrRetrying(true);
		setActionError(null);
		const result = await client.post(`/api/features/${id}/pr-retry`, {
			attemptId,
			confirmation: "retry-pr-creation",
		});
		setIsPrRetrying(false);
		if (!result.ok) {
			setActionError(result.error.message);
			return;
		}
		await loadFeature();
	}

	if (pageState === "loading") return <ViewState state="loading" />;
	if (pageState === "error") return <ViewState state="error" message="Feature not found" />;
	if (!feature) return null;

	const hasJobData = JOB_STATES.has(feature.state);
	const attempts: AttemptRecord[] = feature.attempts.map((attempt) => ({
		id: attempt.id,
		status: attempt.status as AttemptRecord["status"],
		predecessorAttemptId: attempt.predecessorAttemptId ?? undefined,
		queuedAt: String(attempt.enqueuedAt),
		startedAt: attempt.startedAt ? String(attempt.startedAt) : undefined,
		endedAt: attempt.endedAt ? String(attempt.endedAt) : undefined,
		workerId: attempt.workerRegistrationId ?? attempt.worker?.workerId ?? undefined,
		exitCode: attempt.exitCode ?? undefined,
		resultSummary: resultSummary(attempt.structuredResult),
	}));
	const failure = feature.failures[0];
	const observedPrState = feature.pullRequest?.observedState?.toUpperCase();
	const prState =
		observedPrState === "OPEN" || observedPrState === "CLOSED" || observedPrState === "MERGED"
			? observedPrState
			: undefined;
	const checksStatus = deriveCiStatus(feature.state);
	const reviewDecision = deriveReviewDecision(feature.state);
	const prStale = isStalePullRequest(feature.pullRequest?.lastObservedAt ?? null);
	const progressRequirements = mapProgressRequirements(feature.progress?.requirements);
	const taskRequirements: RequirementSummary[] =
		progressRequirements.length > 0
			? progressRequirements.map((requirement) => ({
					...requirement,
					dependsOn: requirement.dependsOn ?? [],
					acceptance: requirement.acceptance ?? [],
				}))
			: (task?.requirements ?? []);
	const diagnosticLog = feature.diagnosticLogs[0];
	const resolvedProjectName = projectName || feature.projectId;
	const activeAttempt =
		feature.activeAttempt ??
		feature.attempts.find(
			(attempt) => attempt.status === "RUNNING" || attempt.status === "QUEUED",
		) ??
		null;
	const queueTime = activeAttempt?.enqueuedAt ? String(activeAttempt.enqueuedAt) : undefined;
	const startTime = activeAttempt?.startedAt ? String(activeAttempt.startedAt) : undefined;
	const lastHeartbeat = activeAttempt?.heartbeatAt
		? String(activeAttempt.heartbeatAt)
		: activeAttempt?.worker?.lastHeartbeatAt
			? String(activeAttempt.worker.lastHeartbeatAt)
			: undefined;
	const workerState = activeAttempt?.status;
	const elapsedMs = elapsedFrom(startTime, activeAttempt?.endedAt ?? null);

	return (
		<section aria-label={`Feature ${feature.title}`}>
			<header>
				<h1>{feature.title}</h1>
				<span>{feature.state.replace(/_/g, " ")}</span>
				<p>{feature.branchName}</p>
			</header>

			<dl>
				<dt>Project</dt>
				<dd>{resolvedProjectName}</dd>
				<dt>Release</dt>
				<dd>{feature.releaseId}</dd>
				<dt>Branch</dt>
				<dd>{feature.branchName}</dd>
			</dl>

			{actionError && <div role="alert">{actionError}</div>}

			{hasJobData && (
				<>
					{feature.progress && (
						<JobProgress
							featureId={feature.id}
							featureState={feature.state}
							totalRequirements={feature.progress.totalRequirements}
							passedRequirements={feature.progress.passedRequirements}
							activeRequirements={feature.progress.activeRequirements}
							stuckRequirements={feature.progress.stuckRequirements}
							invalidRequirements={feature.progress.invalidRequirements}
							remainingRequirements={feature.progress.remainingRequirements}
							requirements={taskRequirements}
							queueTime={queueTime}
							startTime={startTime}
							elapsedMs={elapsedMs}
							workerId={activeAttempt?.workerRegistrationId ?? activeAttempt?.worker?.workerId}
							workerState={workerState}
							lastHeartbeat={lastHeartbeat}
							lastUpdate={feature.progress.lastUpdatedAt ?? undefined}
							activeRequirementId={feature.progress.activeRequirementId ?? undefined}
							recentActivity={feature.recentActivity.map((activity) => ({
								id: activity.id,
								type: activity.type,
								message: activity.summary,
								timestamp: String(activity.occurredAt),
							}))}
							isStale={isLiveStale}
							onRefresh={() => {
								void loadFeature();
							}}
						/>
					)}

					{diagnosticLog && (
						<DiagnosticLogExcerpt log={diagnosticLog.body} truncated={diagnosticLog.truncated} />
					)}

					<AttemptHistory attempts={attempts} />

					<JobActions
						featureId={feature.id}
						featureState={feature.state}
						attemptId={attempts.find((attempt) => attempt.status === "RUNNING")?.id}
						onCancel={handleCancel}
						onRetry={handleRetry}
						onPrRetry={handlePrRetry}
						isCancelling={isCancelling}
						isRetrying={isRetrying}
						isPrRetrying={isPrRetrying}
						cancelRefused={actionError}
						retryRefused={actionError}
						projectName={resolvedProjectName}
						featureTitle={feature.title}
					/>

					{failure && (
						<FailureDetail
							code={failure.category}
							message={failure.summary}
							operation="development"
							attemptId={failure.attemptId ?? undefined}
							timestamp={String(failure.occurredAt)}
							nextAction={failure.recommendedAction}
						/>
					)}

					{PR_STATES.has(feature.state) && feature.pullRequest && (
						<PullRequestStatus
							prNumber={feature.pullRequest.number}
							prUrl={feature.pullRequest.url}
							prState={prState}
							headSha={feature.pullRequest.observedHeadSha ?? undefined}
							checksStatus={checksStatus}
							reviewDecision={reviewDecision}
							mergeCommitSha={feature.pullRequest.mergeCommitSha ?? undefined}
							lastSyncAt={feature.pullRequest.lastObservedAt ?? undefined}
							isStale={prStale}
						/>
					)}
				</>
			)}

			{task ? (
				<TaskReview
					task={task}
					checksum={task.checksum}
					projectName={resolvedProjectName}
					onApprove={handleApprove}
					onRemove={handleRemove}
					onReplace={handleReplace}
					onInvalidate={handleInvalidate}
					isApproving={isApproving}
					featureState={feature.state}
					staleChecksum={staleChecksum}
					onRefresh={handleRefresh}
				/>
			) : (
				!hasJobData && (
					<section aria-label="Attach task">
						<h2>Attach Task File</h2>
						<TaskAttachmentForm
							onSubmit={handleAttachTask}
							isSubmitting={isAttaching}
							serverError={attachError}
						/>
					</section>
				)
			)}
		</section>
	);
}
