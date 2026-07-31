export interface ValidationCheck {
	code: string;
	ok: boolean;
	message: string;
}

export interface ProjectValidationResultsProps {
	checks: ValidationCheck[];
	allPassed: boolean;
}

export function ProjectValidationResults({ checks, allPassed }: ProjectValidationResultsProps) {
	return (
		<section aria-label="Validation results">
			<ul>
				{checks.map((check) => (
					<li
						key={check.code}
						data-check-code={check.code}
						data-check-ok={check.ok ? "true" : "false"}
					>
						<span aria-hidden="true">{check.ok ? "✓" : "✗"}</span>
						<span>{check.message}</span>
					</li>
				))}
			</ul>
			{allPassed ? (
				<div role="status" aria-live="polite">
					All checks passed — ready to save
				</div>
			) : (
				<div role="status" aria-live="polite">
					Save stays disabled until every required check passes
				</div>
			)}
		</section>
	);
}
