export interface FailureDetailProps {
	code: string;
	message: string;
	operation: string;
	attemptId?: string;
	timestamp: string;
	nextAction?: string;
}

function redactCredentials(text: string): string {
	return text
		.replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+/g, "[REDACTED]")
		.replace(/x-access-token:[^@]+@/g, "x-access-token:[REDACTED]@")
		.replace(/(?:password|token|secret|key)=([^&\s]+)/gi, "$1=[REDACTED]")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
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
	const safeMessage = redactCredentials(message);

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
