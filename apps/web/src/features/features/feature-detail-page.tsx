import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ViewState } from "../../components/feedback/view-state";
import type { AttemptRecord } from "../jobs/attempt-history";
import { AttemptHistory } from "../jobs/attempt-history";
import type { FailureDetailProps } from "../jobs/failure-detail";
import { FailureDetail } from "../jobs/failure-detail";
import { JobActions } from "../jobs/job-actions";
import type { RequirementProgress } from "../jobs/job-progress";
import { JobProgress } from "../jobs/job-progress";
import type { PullRequestStatusProps } from "../pull-requests/pull-request-status";
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

interface FeatureDetail {
	id: string;
	title: string;
	slug: string;
	state: string;
	branch: string;
	projectId: string;
	projectName: string;
	releaseId: string;
	releaseName: string;
	taskPath?: string;
	taskChecksum?: string;
	approvalId?: string;
}

interface JobData {
	attempts: AttemptRecord[];
	progress: {
		total: number;
		passed: number;
		active: number;
		stuck: number;
		invalid: number;
		remaining: number;
		requirements: RequirementProgress[];
	};
	failure: FailureDetailProps | null;
	pr?: PullRequestStatusProps;
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

export function FeatureDetailPage() {
	const { id } = useParams<{ id: string }>();
	const [feature, setFeature] = useState<FeatureDetail | null>(null);
	const [task, setTask] = useState<TaskSnapshot | null>(null);
	const [jobData, setJobData] = useState<JobData | null>(null);
	const [pageState, setPageState] = useState<PageState>("loading");
	const [attachError, setAttachError] = useState<string | null>(null);
	const [isAttaching, setIsAttaching] = useState(false);
	const [isApproving, setIsApproving] = useState(false);
	const [staleChecksum, setStaleChecksum] = useState(false);

	useEffect(() => {
		async function load() {
			try {
				const res = await fetch(`/api/features/${id}`, { credentials: "include" });
				if (!res.ok) {
					setPageState("error");
					return;
				}
				const body = await res.json();
				const data = body.data ?? body;
				setFeature(data);
				setPageState("ready");
			} catch {
				setPageState("error");
			}
		}
		load();
	}, [id]);

	useEffect(() => {
		async function loadTask() {
			if (!feature?.taskPath) return;
			try {
				const res = await fetch(`/api/features/${id}/task`, { credentials: "include" });
				if (res.ok) {
					const body = await res.json();
					if (body.ok) {
						setTask(body.data);
					}
				}
			} catch {
				// Task load failed silently
			}
		}
		loadTask();
	}, [feature?.taskPath, id]);

	useEffect(() => {
		const featureState = feature?.state;
		const featureId = feature?.id;
		if (!featureState || !featureId || !JOB_STATES.has(featureState)) return;
		let cancelled = false;
		async function loadJobs() {
			try {
				const res = await fetch(`/api/features/${id}/jobs`, { credentials: "include" });
				if (res.ok && !cancelled) {
					const body = await res.json();
					if (body.ok) {
						setJobData(body.data);
					}
				}
			} catch {
				// Job load failed silently
			}
		}
		loadJobs();
		return () => {
			cancelled = true;
		};
	}, [feature?.state, feature?.id, id]);

	async function handleAttachTask(taskPath: string) {
		setIsAttaching(true);
		setAttachError(null);
		try {
			const res = await fetch(`/api/features/${id}/task`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ taskPath }),
			});
			const body = await res.json();
			if (body.ok) {
				setAttachError(null);
				const featRes = await fetch(`/api/features/${id}`, { credentials: "include" });
				if (featRes.ok) {
					setFeature(await featRes.json());
				}
			} else {
				setAttachError(body.error?.message || "Failed to attach task");
			}
		} catch {
			setAttachError("Unable to reach server");
		} finally {
			setIsAttaching(false);
		}
	}

	async function handleApprove() {
		setIsApproving(true);
		try {
			const res = await fetch(`/api/features/${id}/approve`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ checksum: task?.checksum }),
			});
			const body = await res.json();
			if (body.ok) {
				setStaleChecksum(false);
				const featRes = await fetch(`/api/features/${id}`, { credentials: "include" });
				if (featRes.ok) {
					setFeature(await featRes.json());
				}
			} else if (body.error?.code === "STALE_CHECKSUM") {
				setStaleChecksum(true);
			}
		} finally {
			setIsApproving(false);
		}
	}

	async function handleRemove() {
		await fetch(`/api/features/${id}/task`, {
			method: "DELETE",
			credentials: "include",
		});
		setTask(null);
		if (feature) {
			setFeature({ ...feature, taskPath: undefined, taskChecksum: undefined });
		}
	}

	async function handleReplace(path: string) {
		await handleAttachTask(path);
	}

	async function handleInvalidate() {
		await fetch(`/api/features/${id}/invalidate`, {
			method: "POST",
			credentials: "include",
		});
	}

	function handleRefresh() {
		setStaleChecksum(false);
		fetch(`/api/features/${id}/task`, { credentials: "include" })
			.then((r) => r.json())
			.then((body) => {
				if (body.ok) setTask(body.data);
			})
			.catch(() => {});
	}

	async function handleCancel() {
		await fetch(`/api/features/${id}/cancel`, {
			method: "POST",
			credentials: "include",
		});
		const featRes = await fetch(`/api/features/${id}`, { credentials: "include" });
		if (featRes.ok) {
			setFeature(await featRes.json());
		}
	}

	async function handleRetry() {
		await fetch(`/api/features/${id}/retry`, {
			method: "POST",
			credentials: "include",
		});
		const featRes = await fetch(`/api/features/${id}`, { credentials: "include" });
		if (featRes.ok) {
			setFeature(await featRes.json());
		}
	}

	async function handlePrRetry() {
		await fetch(`/api/features/${id}/pr-retry`, {
			method: "POST",
			credentials: "include",
		});
		const featRes = await fetch(`/api/features/${id}`, { credentials: "include" });
		if (featRes.ok) {
			setFeature(await featRes.json());
		}
	}

	if (pageState === "loading") return <ViewState state="loading" />;
	if (pageState === "error") return <ViewState state="error" message="Feature not found" />;
	if (!feature) return null;

	const hasJobData = JOB_STATES.has(feature.state);

	return (
		<section aria-label={`Feature ${feature.title}`}>
			<header>
				<h1>{feature.title}</h1>
				<span>{feature.state.replace(/_/g, " ")}</span>
				<p>{feature.branch}</p>
			</header>

			<dl>
				<dt>Project</dt>
				<dd>{feature.projectName}</dd>
				<dt>Release</dt>
				<dd>{feature.releaseName}</dd>
				<dt>Branch</dt>
				<dd>{feature.branch}</dd>
			</dl>

			{hasJobData && jobData && (
				<>
					<JobProgress
						featureId={feature.id}
						featureState={feature.state}
						totalRequirements={jobData.progress.total}
						passedRequirements={jobData.progress.passed}
						activeRequirements={jobData.progress.active}
						stuckRequirements={jobData.progress.stuck}
						invalidRequirements={jobData.progress.invalid}
						remainingRequirements={jobData.progress.remaining}
						requirements={jobData.progress.requirements}
						recentActivity={[]}
					/>

					<AttemptHistory attempts={jobData.attempts} />

					<JobActions
						featureId={feature.id}
						featureState={feature.state}
						attemptId={jobData.attempts.find((a) => a.status === "RUNNING")?.id}
						onCancel={handleCancel}
						onRetry={handleRetry}
						onPrRetry={handlePrRetry}
					/>

					{jobData.failure && (
						<FailureDetail
							code={jobData.failure.code}
							message={jobData.failure.message}
							operation={jobData.failure.operation}
							attemptId={jobData.failure.attemptId}
							timestamp={jobData.failure.timestamp}
							nextAction={jobData.failure.nextAction}
						/>
					)}

					{PR_STATES.has(feature.state) && jobData.pr && <PullRequestStatus {...jobData.pr} />}
				</>
			)}

			{task ? (
				<TaskReview
					task={task}
					checksum={task.checksum}
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
