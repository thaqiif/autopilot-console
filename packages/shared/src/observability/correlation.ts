export type CorrelationScope = "http" | "job" | "process" | "git" | "github" | "activity" | "audit";

export interface CorrelationOptions {
	parent?: string;
	scope?: CorrelationScope;
}

function randomSegment(): string {
	// 12 hex chars from crypto — short, URL-safe, unique enough for correlation.
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a correlation id. Child scopes embed the parent so HTTP → job → git/github
 * → activity/audit chains remain reconstructable from logs and audit rows.
 */
export function createCorrelationId(options: CorrelationOptions = {}): string {
	const leaf = randomSegment();
	if (options.parent && options.scope) {
		return `${options.parent}/${options.scope}:${leaf}`;
	}
	if (options.parent) {
		return `${options.parent}/${leaf}`;
	}
	if (options.scope) {
		return `${options.scope}:${leaf}`;
	}
	return `corr_${leaf}`;
}

export interface CorrelationContext {
	correlationId: string;
	scope?: CorrelationScope;
	projectId?: string;
	featureId?: string;
	jobAttemptId?: string;
}

export function childCorrelation(
	parent: CorrelationContext,
	scope: CorrelationScope,
	extra: Partial<Omit<CorrelationContext, "correlationId" | "scope">> = {},
): CorrelationContext {
	return {
		...parent,
		...extra,
		scope,
		correlationId: createCorrelationId({ parent: parent.correlationId, scope }),
	};
}
