export interface RequirementSummary {
	id: string;
	description: string;
	status: "not_started" | "in_progress" | "passed" | "stuck" | "invalid";
	passes: boolean;
	stuck: boolean;
	stuckReason?: string;
	invalidTest: boolean;
	invalidTestReason?: string;
	blockedReason?: string;
	dependsOn: string[];
	acceptance: string[];
	redPhase: boolean;
	greenPhase: boolean;
	refactorPhase: boolean;
}

export interface RequirementCardProps {
	requirement: RequirementSummary;
}

function statusMeta(requirement: RequirementSummary): {
	key: RequirementSummary["status"];
	label: string;
	icon: string;
} {
	if (requirement.passes || requirement.status === "passed") {
		return { key: "passed", label: "Passed", icon: "✓" };
	}
	if (requirement.stuck || requirement.status === "stuck") {
		return { key: "stuck", label: "Stuck", icon: "!" };
	}
	if (requirement.invalidTest || requirement.status === "invalid") {
		return { key: "invalid", label: "Invalid", icon: "×" };
	}
	if (requirement.status === "in_progress") {
		return { key: "in_progress", label: "In Progress", icon: "…" };
	}
	return { key: "not_started", label: "Not Started", icon: "○" };
}

function StatusBadge({ requirement }: { requirement: RequirementSummary }) {
	const status = statusMeta(requirement);
	return (
		<span data-status={status.key}>
			<span aria-hidden="true">{status.icon}</span> {status.label}
		</span>
	);
}

function TDDPhases({ red, green, refactor }: { red: boolean; green: boolean; refactor: boolean }) {
	return (
		<div>
			<span>Red: {red ? "Complete" : "Pending"}</span>
			<span>Green: {green ? "Complete" : "Pending"}</span>
			<span>Refactor: {refactor ? "Complete" : "Pending"}</span>
		</div>
	);
}

export function RequirementCard({ requirement }: RequirementCardProps) {
	const {
		id,
		description,
		stuckReason,
		invalidTestReason,
		blockedReason,
		dependsOn,
		acceptance,
		redPhase,
		greenPhase,
		refactorPhase,
	} = requirement;

	return (
		<article aria-label={`Requirement ${id}`}>
			<header>
				<span>{id}</span>
				<h4>{description}</h4>
				<StatusBadge requirement={requirement} />
			</header>

			<TDDPhases red={redPhase} green={greenPhase} refactor={refactorPhase} />

			{stuckReason && <p>Stuck: {stuckReason}</p>}

			{invalidTestReason && <p>Invalid: {invalidTestReason}</p>}

			{blockedReason && <p>Blocked: {blockedReason}</p>}

			{dependsOn.length > 0 && <p>Depends on: {dependsOn.join(", ")}</p>}

			{acceptance.length > 0 && (
				<details>
					<summary>{acceptance.length} acceptance criteria</summary>
					<ul>
						{acceptance.map((criterion) => (
							<li key={criterion}>{criterion}</li>
						))}
					</ul>
				</details>
			)}
		</article>
	);
}
