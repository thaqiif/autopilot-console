export interface DiagnosticLogExcerptProps {
	log: string;
	maxLines?: number;
	truncated?: boolean;
}

function redactCredentials(text: string): string {
	return text
		.replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+/g, "[REDACTED]")
		.replace(/x-access-token:[^@]+@/g, "x-access-token:[REDACTED]@")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

export function DiagnosticLogExcerpt({ log, maxLines, truncated }: DiagnosticLogExcerptProps) {
	const lines = log.split("\n");
	const needsTruncation = maxLines != null && lines.length > maxLines;
	const displayLines = needsTruncation ? lines.slice(0, maxLines) : lines;
	const safeLines = displayLines.map(redactCredentials);
	const isTruncated = truncated || needsTruncation;

	return (
		<section aria-label="Diagnostic log">
			<h4>Diagnostic Log</h4>
			<pre>
				<code>{safeLines.join("\n")}</code>
			</pre>
			{isTruncated && (
				<p role="status">
					Truncated — {lines.length - (maxLines ?? lines.length)} more lines not shown
				</p>
			)}
		</section>
	);
}
