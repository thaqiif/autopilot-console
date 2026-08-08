import { redactSecrets } from "@autopilot-console/shared/security/redaction";
import { useCallback, useState } from "react";

export interface DiagnosticLogExcerptProps {
	log: string;
	maxLines?: number;
	truncated?: boolean;
}

export function DiagnosticLogExcerpt({ log, maxLines, truncated }: DiagnosticLogExcerptProps) {
	const lines = log.split("\n");
	const needsTruncation = maxLines != null && lines.length > maxLines;
	const displayLines = needsTruncation ? lines.slice(0, maxLines) : lines;
	const safeLines = displayLines.map(redactSecrets);
	const isTruncated = truncated || needsTruncation;
	const safeContent = safeLines.join("\n");
	const [copyLabel, setCopyLabel] = useState("Copy");

	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(safeContent).then(() => {
			setCopyLabel("Copied");
			setTimeout(() => setCopyLabel("Copy"), 2000);
		});
	}, [safeContent]);

	const handleDownload = useCallback(() => {
		const blob = new Blob([safeContent], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "diagnostic-log.txt";
		a.click();
		URL.revokeObjectURL(url);
	}, [safeContent]);

	return (
		<section aria-label="Diagnostic log">
			<h4>Diagnostic Log</h4>
			<div>
				<button
					type="button"
					onClick={handleCopy}
					aria-label="Copy log to clipboard"
					style={{ minHeight: 44, minWidth: 44 }}
				>
					{copyLabel}
				</button>
				<button
					type="button"
					onClick={handleDownload}
					aria-label="Download log as file"
					style={{ minHeight: 44, minWidth: 44 }}
				>
					Download
				</button>
			</div>
			<pre>
				<code>{safeContent}</code>
			</pre>
			{isTruncated && (
				<p role="status">
					Truncated — {lines.length - (maxLines ?? lines.length)} more lines not shown
				</p>
			)}
		</section>
	);
}
