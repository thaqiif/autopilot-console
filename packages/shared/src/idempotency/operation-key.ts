import type { FeatureId, JobAttemptId, ProjectId } from "../contracts/ids";

export type OperationName =
	| "approve_and_queue"
	| "cancel"
	| "retry_development"
	| "retry_pr_creation"
	| "push_branch"
	| "create_pr"
	| "poll_pr";

export interface OperationKeyParts {
	operation: OperationName | string;
	projectId: ProjectId | string;
	featureId?: FeatureId | string;
	jobAttemptId?: JobAttemptId | string;
	checksum?: string;
	/** Extra discriminator for operations that need more than the standard fields. */
	subject?: string;
}

export interface ParsedOperationKey {
	operation: string;
	projectId: string;
	featureId?: string;
	jobAttemptId?: string;
	checksum?: string;
	subject?: string;
}

/**
 * Stable operation key. Same inputs always produce the same key so HTTP retries
 * and double-taps collapse. Different entity IDs cannot collide across operations.
 */
export function createOperationKey(parts: OperationKeyParts): string {
	const segments = [
		parts.operation,
		`project=${parts.projectId}`,
		parts.featureId !== undefined ? `feature=${parts.featureId}` : undefined,
		parts.jobAttemptId !== undefined ? `job=${parts.jobAttemptId}` : undefined,
		parts.checksum !== undefined ? `checksum=${parts.checksum}` : undefined,
		parts.subject !== undefined ? `subject=${parts.subject}` : undefined,
	].filter((segment): segment is string => segment !== undefined);
	return segments.join(":");
}

export function parseOperationKey(key: string): ParsedOperationKey {
	const [operation, ...rest] = key.split(":");
	if (!operation || rest.length === 0) {
		throw new Error(`Invalid operation key: ${key}`);
	}
	const parsed: ParsedOperationKey = { operation, projectId: "" };
	for (const segment of rest) {
		const eq = segment.indexOf("=");
		if (eq <= 0) continue;
		const name = segment.slice(0, eq);
		const value = segment.slice(eq + 1);
		if (name === "project") parsed.projectId = value;
		else if (name === "feature") parsed.featureId = value;
		else if (name === "job") parsed.jobAttemptId = value;
		else if (name === "checksum") parsed.checksum = value;
		else if (name === "subject") parsed.subject = value;
	}
	if (!parsed.projectId) {
		throw new Error(`Invalid operation key missing project: ${key}`);
	}
	return parsed;
}
