import { useState } from "react";
import { ApprovalConfirmation } from "./approval-confirmation";
import type { RequirementSummary } from "./requirement-card";
import { RequirementCard } from "./requirement-card";

interface TaskSnapshot {
	name: string;
	description: string;
	goals: string[];
	nonGoals: string[];
	requirements: RequirementSummary[];
	checksum: string;
	rawJson?: string;
}

const REPLACEABLE_STATES = new Set([
	"TASKS_REVIEW",
	"PLANNED",
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
]);

const REAPPROVABLE_STATES = new Set([
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
]);

export interface TaskReviewProps {
	task: TaskSnapshot;
	checksum: string;
	projectName: string;
	onApprove: () => void;
	onRemove: () => void;
	onReplace: (path: string) => void;
	onInvalidate: () => void;
	isApproving?: boolean;
	featureState: string;
	staleChecksum?: boolean;
	onRefresh?: () => void;
}

export function TaskReview({
	task,
	checksum,
	projectName,
	onApprove,
	onRemove,
	onReplace,
	onInvalidate,
	isApproving,
	featureState,
	staleChecksum,
	onRefresh,
}: TaskReviewProps) {
	const [showRawJson, setShowRawJson] = useState(false);
	const [showApproveDialog, setShowApproveDialog] = useState(false);
	const [showReplaceDialog, setShowReplaceDialog] = useState(false);
	const [replacePath, setReplacePath] = useState("");

	const canModify = REPLACEABLE_STATES.has(featureState);

	function handleConfirmApprove() {
		setShowApproveDialog(false);
		onApprove();
	}

	function handleReplace() {
		if (replacePath.trim()) {
			onReplace(replacePath.trim());
			setShowReplaceDialog(false);
			setReplacePath("");
		}
	}

	return (
		<section aria-label="Task review" style={{ maxWidth: "100%", overflowWrap: "anywhere" }}>
			<header>
				<h3>{task.name}</h3>
				<p>{task.description}</p>
			</header>

			{staleChecksum && (
				<div role="alert">
					<p>The task file has changed since your last review. Please refresh.</p>
					{onRefresh && (
						<button type="button" onClick={onRefresh}>
							Refresh
						</button>
					)}
				</div>
			)}

			<dl>
				<dt>Checksum</dt>
				<dd>{checksum}</dd>
			</dl>

			{task.goals.length > 0 && (
				<section>
					<h4>Goals</h4>
					<ul>
						{task.goals.map((goal) => (
							<li key={goal}>{goal}</li>
						))}
					</ul>
				</section>
			)}

			{task.nonGoals.length > 0 && (
				<section>
					<h4>Non-Goals</h4>
					<ul>
						{task.nonGoals.map((ng) => (
							<li key={ng}>{ng}</li>
						))}
					</ul>
				</section>
			)}

			<section>
				<h4>Requirements ({task.requirements.length})</h4>
				{task.requirements.map((req) => (
					<RequirementCard key={req.id} requirement={req} />
				))}
			</section>

			{task.rawJson && (
				<section>
					<button type="button" onClick={() => setShowRawJson(!showRawJson)}>
						{showRawJson ? "Hide Raw JSON" : "Show Raw JSON"}
					</button>
					{showRawJson && (
						<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
							<code>{task.rawJson}</code>
						</pre>
					)}
				</section>
			)}

			<div>
				{!staleChecksum && (
					<button type="button" onClick={() => setShowApproveDialog(true)} disabled={isApproving}>
						Approve &amp; Queue Development
					</button>
				)}

				{canModify && (
					<>
						<button type="button" onClick={onRemove}>
							Remove
						</button>
						<button type="button" onClick={() => setShowReplaceDialog(true)}>
							Replace
						</button>
						<button type="button" onClick={onInvalidate}>
							Invalidate
						</button>
					</>
				)}

				{REAPPROVABLE_STATES.has(featureState) && !staleChecksum && (
					<button type="button" onClick={() => setShowApproveDialog(true)} disabled={isApproving}>
						Reapprove
					</button>
				)}
			</div>

			{showApproveDialog && (
				<ApprovalConfirmation
					projectName={projectName}
					featureName={task.name}
					checksum={checksum}
					onConfirm={handleConfirmApprove}
					onCancel={() => setShowApproveDialog(false)}
					isSubmitting={isApproving}
				/>
			)}

			{showReplaceDialog && (
				<div role="dialog" aria-modal="true" aria-label="Replace task file">
					<h3>Replace Task File</h3>
					<p>
						Prior approvals and attempt history will be preserved. You will need to reapprove the
						new task file.
					</p>
					<div>
						<label htmlFor="replace-task-path">New task path</label>
						<input
							id="replace-task-path"
							value={replacePath}
							onChange={(e) => setReplacePath(e.target.value)}
							placeholder="tasks/new-task.json"
						/>
					</div>
					<div>
						<button type="button" onClick={() => setShowReplaceDialog(false)}>
							Cancel
						</button>
						<button type="button" onClick={handleReplace}>
							Replace
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
