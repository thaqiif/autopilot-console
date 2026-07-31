export interface ConfirmDialogProps {
	/** Accessible name for the dialog. */
	label: string;
	/** Exact entity name shown in the confirmation copy. */
	entityName: string;
	/** Verb used in the confirm button, e.g. "archive". */
	action: string;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

/**
 * Accessible confirmation dialog that always names the exact target entity.
 */
export function ConfirmDialog({
	label,
	entityName,
	action,
	busy,
	onCancel,
	onConfirm,
}: ConfirmDialogProps) {
	const confirmLabel = `Confirm ${action}`;
	return (
		<div role="dialog" aria-modal="true" aria-label={label}>
			<p>
				Are you sure you want to {action} <strong>{entityName}</strong>?
			</p>
			<button type="button" onClick={onCancel}>
				Cancel
			</button>
			<button type="button" onClick={onConfirm} disabled={busy}>
				{confirmLabel}
			</button>
		</div>
	);
}
