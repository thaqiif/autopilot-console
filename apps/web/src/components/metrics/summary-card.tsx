export interface SummaryCardProps {
	label: string;
	value: number | string;
}

export function SummaryCard({ label, value }: SummaryCardProps) {
	return (
		<div className="summary-card">
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}
