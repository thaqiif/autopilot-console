import { useRef, useState } from "react";
import { FocusTrap } from "../../components/feedback/focus-trap";

export interface JobActionsProps {
	featureId: string;
	featureState: string;
	attemptId?: string;
	onCancel?: () => void;
	onRetry?: () => void;
	onPrRetry?: () => void;
	isCancelling?: boolean;
	isRetrying?: boolean;
	isPrRetrying?: boolean;
	cancelRefused?: string | null;
	retryRefused?: string | null;
	projectName?: string;
	featureTitle?: string;
}

const Cancellable_STATES = new Set(["QUEUED", "DEVELOPING", "RUNNING"]);
const RETRYABLE_STATES = new Set([
	"DEVELOPMENT_FAILED",
	"DEVELOPMENT_INTERRUPTED",
	"DEVELOPMENT_CANCELLED",
]);
const PR_RETRYABLE_STATES = new Set(["PR_CREATION_FAILED"]);
const TERMINAL_STATES = new Set(["DEVELOPMENT_MERGED", "DEVELOPMENT_COMPLETE"]);

export function JobActions({
	featureState,
	onCancel,
	onRetry,
	onPrRetry,
	isCancelling,
	isRetrying,
	isPrRetrying,
	cancelRefused,
	retryRefused,
	projectName,
	featureTitle,
}: JobActionsProps) {
	const [showCancelDialog, setShowCancelDialog] = useState(false);
	const [showRetryDialog, setShowRetryDialog] = useState(false);
	const [showPrRetryDialog, setShowPrRetryDialog] = useState(false);
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const retryButtonRef = useRef<HTMLButtonElement>(null);
	const prRetryButtonRef = useRef<HTMLButtonElement>(null);

	if (TERMINAL_STATES.has(featureState)) {
		return null;
	}

	const canCancel = Cancellable_STATES.has(featureState);
	const canRetry = RETRYABLE_STATES.has(featureState);
	const canPrRetry = PR_RETRYABLE_STATES.has(featureState);

	function handleConfirmCancel() {
		setShowCancelDialog(false);
		onCancel?.();
	}

	function handleConfirmRetry() {
		setShowRetryDialog(false);
		onRetry?.();
	}

	function handleConfirmPrRetry() {
		setShowPrRetryDialog(false);
		onPrRetry?.();
	}

	return (
		<section aria-label="Job actions">
			{canCancel && (
				<button
					ref={cancelButtonRef}
					type="button"
					onClick={() => setShowCancelDialog(true)}
					disabled={isCancelling}
				>
					Cancel
				</button>
			)}

			{canRetry && (
				<button
					ref={retryButtonRef}
					type="button"
					onClick={() => setShowRetryDialog(true)}
					disabled={isRetrying}
				>
					Retry
				</button>
			)}

			{canPrRetry && (
				<button
					ref={prRetryButtonRef}
					type="button"
					onClick={() => setShowPrRetryDialog(true)}
					disabled={isPrRetrying}
				>
					Retry PR
				</button>
			)}

			{cancelRefused && (
				<div role="alert">
					<p>{cancelRefused}</p>
				</div>
			)}

			{retryRefused && (
				<div role="alert">
					<p>{retryRefused}</p>
				</div>
			)}

			{showCancelDialog && (
				<div className="dialog-backdrop" role="presentation">
					<FocusTrap
						active
						onEscape={() => setShowCancelDialog(false)}
						restoreFocusTo={cancelButtonRef.current}
					>
						<div
							role="dialog"
							aria-modal="true"
							aria-label="Confirm cancellation"
							className="dialog-panel"
						>
							<h3>Cancel Development</h3>
							<p>
								{projectName && featureTitle
									? `Cancel development for ${featureTitle} in project ${projectName}? The process will be signaled to stop gracefully.`
									: "This will cancel the current development for this feature. The process will be signaled to stop gracefully."}
							</p>
							<div className="dialog-actions">
								<button type="button" onClick={() => setShowCancelDialog(false)}>
									Cancel
								</button>
								<button type="button" onClick={handleConfirmCancel}>
									Confirm
								</button>
							</div>
						</div>
					</FocusTrap>
				</div>
			)}

			{showRetryDialog && (
				<div className="dialog-backdrop" role="presentation">
					<FocusTrap
						active
						onEscape={() => setShowRetryDialog(false)}
						restoreFocusTo={retryButtonRef.current}
					>
						<div
							role="dialog"
							aria-modal="true"
							aria-label="Confirm retry"
							className="dialog-panel"
						>
							<h3>Retry Development</h3>
							<p>
								This will create a new development attempt for{" "}
								{projectName && featureTitle ? `${featureTitle} in ${projectName}` : "this feature"}{" "}
								using the same feature branch and current task progress. Prior attempts and logs
								will be preserved.
							</p>
							<div className="dialog-actions">
								<button type="button" onClick={() => setShowRetryDialog(false)}>
									Cancel
								</button>
								<button type="button" onClick={handleConfirmRetry}>
									Confirm
								</button>
							</div>
						</div>
					</FocusTrap>
				</div>
			)}

			{showPrRetryDialog && (
				<div className="dialog-backdrop" role="presentation">
					<FocusTrap
						active
						onEscape={() => setShowPrRetryDialog(false)}
						restoreFocusTo={prRetryButtonRef.current}
					>
						<div
							role="dialog"
							aria-modal="true"
							aria-label="Confirm PR retry"
							className="dialog-panel"
						>
							<h3>Retry PR Creation</h3>
							<p>
								This will retry creating the pull request for{" "}
								{projectName && featureTitle ? `${featureTitle} in ${projectName}` : "this feature"}
								. The existing branch push will be reused if possible.
							</p>
							<div className="dialog-actions">
								<button type="button" onClick={() => setShowPrRetryDialog(false)}>
									Cancel
								</button>
								<button type="button" onClick={handleConfirmPrRetry}>
									Confirm
								</button>
							</div>
						</div>
					</FocusTrap>
				</div>
			)}
		</section>
	);
}
