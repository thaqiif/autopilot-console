import { FocusTrap } from "../../components/feedback/focus-trap";

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
		<div className="dialog-backdrop" role="presentation">
			<FocusTrap active onEscape={onCancel}>
				<div
					role="dialog"
					aria-modal="true"
					aria-label={`Approve tasks for ${featureName}`}
					className="dialog-panel"
				>
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

					<div className="dialog-actions">
						<button type="button" onClick={onCancel}>
							Cancel
						</button>
						<button type="button" onClick={onConfirm} disabled={isSubmitting}>
							Confirm
						</button>
					</div>
				</div>
			</FocusTrap>
		</div>
	);
}
