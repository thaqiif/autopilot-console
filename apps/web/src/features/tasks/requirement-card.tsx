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

function StatusBadge({
	status,
	passes,
	stuck,
	invalidTest,
}: {
	status: string;
	passes: boolean;
	stuck: boolean;
	invalidTest: boolean;
}) {
	if (passes || status === "passed") {
		return <span>Passed</span>;
	}
	if (stuck || status === "stuck") {
		return <span>Stuck</span>;
	}
	if (invalidTest || status === "invalid") {
		return <span>Invalid</span>;
	}
	if (status === "in_progress") {
		return <span>In Progress</span>;
	}
	return <span>Not Started</span>;
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
		status,
		passes,
		stuck,
		stuckReason,
		invalidTest,
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
				<StatusBadge status={status} passes={passes} stuck={stuck} invalidTest={invalidTest} />
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
