export interface ApprovalConfirmationProps {
	projectName: string;
	featureName: string;
	checksum: string;
	onConfirm: () => void;
	onCancel: () => void;
	isSubmitting?: boolean;
}

export function ApprovalConfirmation({
	projectName,
	featureName,
	checksum,
	onConfirm,
	onCancel,
	isSubmitting,
}: ApprovalConfirmationProps) {
	return (
		<div role="dialog" aria-modal="true" aria-label={`Approve tasks for ${featureName}`}>
			<header>
				<h3>Approve &amp; Queue Development</h3>
			</header>

			<p>
				You are about to approve tasks for <strong>{featureName}</strong> in project{" "}
				<strong>{projectName}</strong>.
			</p>

			<dl>
				<dt>Checksum</dt>
				<dd>{checksum}</dd>
			</dl>

			<p>
				This will create a new development attempt and queue it for execution. The task artifact
				will be snapshotted with this checksum.
			</p>

			<div>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" onClick={onConfirm} disabled={isSubmitting}>
					Confirm
				</button>
			</div>
		</div>
	);
}
