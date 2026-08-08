/**
 * Structured logging with correlation, context, and automatic redaction.
 *
 * Every log entry includes ISO-8601 UTC timestamp, level, message, and any
 * bound context (correlationId, projectId, featureId, jobAttemptId).
 * Sensitive fields are redacted before serialization.
 */

import { redactValue } from "../security/redaction";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
	correlationId?: string;
	projectId?: string;
	featureId?: string;
	jobAttemptId?: string;
	[key: string]: unknown;
}

export interface StructuredLogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	context?: Record<string, unknown>;
}

export interface StructuredLogger {
	debug(message: string, context?: LogContext): void;
	info(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext): void;
	error(message: string, context?: LogContext): void;
	child(context: LogContext): StructuredLogger;
}

export interface StructuredLoggerOptions {
	level?: LogLevel;
	now?: () => Date;
	write?: (entry: StructuredLogEntry) => void;
	baseContext?: LogContext;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export function createStructuredLogger(options: StructuredLoggerOptions = {}): StructuredLogger {
	const minLevel = options.level ?? "info";
	const minPriority = LOG_LEVEL_PRIORITY[minLevel];
	const now = options.now ?? (() => new Date());
	const baseContext: LogContext = options.baseContext ?? {};
	const write =
		options.write ??
		((entry: StructuredLogEntry) => {
			const line = JSON.stringify(entry);
			if (entry.level === "error") {
				process.stderr.write(`${line}\n`);
			} else {
				process.stdout.write(`${line}\n`);
			}
		});

	function log(level: LogLevel, message: string, context?: LogContext): void {
		if (LOG_LEVEL_PRIORITY[level] < minPriority) return;

		const merged: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(baseContext)) {
			if (value !== undefined) merged[key] = value;
		}
		if (context) {
			for (const [key, value] of Object.entries(context)) {
				if (value !== undefined) merged[key] = value;
			}
		}

		const safeContext =
			Object.keys(merged).length > 0 ? (redactValue(merged) as Record<string, unknown>) : undefined;

		write({
			timestamp: now().toISOString(),
			level,
			message,
			context: safeContext,
		});
	}

	return {
		debug: (message, context) => log("debug", message, context),
		info: (message, context) => log("info", message, context),
		warn: (message, context) => log("warn", message, context),
		error: (message, context) => log("error", message, context),
		child: (extra: LogContext) =>
			createStructuredLogger({
				level: minLevel,
				now,
				write,
				baseContext: { ...baseContext, ...extra },
			}),
	};
}
