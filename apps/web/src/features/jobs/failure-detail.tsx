import { redactSecrets } from "@autopilot-console/shared/security/redaction";
import { LocalDateTime } from "../../time/local-date-time";

export interface FailureDetailProps {
	code: string;
	message: string;
	operation: string;
	attemptId?: string;
	timestamp: string;
	nextAction?: string;
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
				<dd>
					<LocalDateTime utc={timestamp} showTimezone />
				</dd>
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
