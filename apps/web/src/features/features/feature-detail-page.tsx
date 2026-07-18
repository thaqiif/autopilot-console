import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ViewState } from "../../components/feedback/view-state";
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

type PageState = "loading" | "ready" | "error";

export function FeatureDetailPage() {
	const { id } = useParams<{ id: string }>();
	const [feature, setFeature] = useState<FeatureDetail | null>(null);
	const [task, setTask] = useState<TaskSnapshot | null>(null);
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
				// Reload feature to get updated task path
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
				// Reload feature to get updated state
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
		// Reload task snapshot
		fetch(`/api/features/${id}/task`, { credentials: "include" })
			.then((r) => r.json())
			.then((body) => {
				if (body.ok) setTask(body.data);
			})
			.catch(() => {});
	}

	if (pageState === "loading") return <ViewState state="loading" />;
	if (pageState === "error") return <ViewState state="error" message="Feature not found" />;
	if (!feature) return null;

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
				<section aria-label="Attach task">
					<h2>Attach Task File</h2>
					<TaskAttachmentForm
						onSubmit={handleAttachTask}
						isSubmitting={isAttaching}
						serverError={attachError}
					/>
				</section>
			)}
		</section>
	);
}
