import { useRef } from "react";
import { FocusTrap } from "./focus-trap";

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
	const openerRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null,
	);

	return (
		<div className="dialog-backdrop" role="presentation">
			<FocusTrap active onEscape={onCancel} restoreFocusTo={openerRef.current}>
				<div role="dialog" aria-modal="true" aria-label={label} className="dialog-panel">
					<p>
						Are you sure you want to {action} <strong>{entityName}</strong>?
					</p>
					<div className="dialog-actions">
						<button type="button" onClick={onCancel}>
							Cancel
						</button>
						<button type="button" onClick={onConfirm} disabled={busy}>
							{confirmLabel}
						</button>
					</div>
				</div>
			</FocusTrap>
		</div>
	);
}
