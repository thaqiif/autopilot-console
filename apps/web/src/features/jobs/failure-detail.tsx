export interface FailureDetailProps {
	code: string;
	message: string;
	operation: string;
	attemptId?: string;
	timestamp: string;
	nextAction?: string;
}

function formatTimestamp(iso: string): string {
	try {
		return new Date(iso).toLocaleString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	} catch {
		return iso;
	}
}

export function FailureDetail({
	code,
	message,
	operation,
	attemptId,
	timestamp,
	nextAction,
}: FailureDetailProps) {
	const safeMessage = redactSecrets(message);

	return (
		<div role="alert" aria-label="Failure detail">
			<h4>Failure</h4>
			<dl>
				<dt>Code</dt>
				<dd>{code}</dd>
				<dt>Operation</dt>
				<dd>{operation}</dd>
				{attemptId && (
					<>
						<dt>Attempt</dt>
						<dd>{attemptId}</dd>
					</>
				)}
				<dt>Time</dt>
				<dd>{formatTimestamp(timestamp)}</dd>
			</dl>
			<p>{safeMessage}</p>
			{nextAction && (
				<p>
					<strong>Next action: </strong>
					{nextAction}
				</p>
			)}
		</div>
	);
}

import { redactSecrets } from "@autopilot-console/shared/security/redaction";
