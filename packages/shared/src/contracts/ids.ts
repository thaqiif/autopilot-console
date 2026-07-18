declare const projectIdBrand: unique symbol;
declare const releaseIdBrand: unique symbol;
declare const featureIdBrand: unique symbol;
declare const jobAttemptIdBrand: unique symbol;
declare const sessionIdBrand: unique symbol;
declare const pullRequestIdBrand: unique symbol;

export type ProjectId = string & { readonly [projectIdBrand]: typeof projectIdBrand };
export type ReleaseId = string & { readonly [releaseIdBrand]: typeof releaseIdBrand };
export type FeatureId = string & { readonly [featureIdBrand]: typeof featureIdBrand };
export type JobAttemptId = string & {
	readonly [jobAttemptIdBrand]: typeof jobAttemptIdBrand;
};
export type SessionId = string & { readonly [sessionIdBrand]: typeof sessionIdBrand };
export type PullRequestId = string & {
	readonly [pullRequestIdBrand]: typeof pullRequestIdBrand;
};

function assertNonEmptyId(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`Invalid ${label}: id must be non-empty`);
	}
	return trimmed;
}

export function asProjectId(value: string): ProjectId {
	return assertNonEmptyId(value, "project id") as ProjectId;
}

export function asReleaseId(value: string): ReleaseId {
	return assertNonEmptyId(value, "release id") as ReleaseId;
}

export function asFeatureId(value: string): FeatureId {
	return assertNonEmptyId(value, "feature id") as FeatureId;
}

export function asJobAttemptId(value: string): JobAttemptId {
	return assertNonEmptyId(value, "job attempt id") as JobAttemptId;
}

export function asSessionId(value: string): SessionId {
	return assertNonEmptyId(value, "session id") as SessionId;
}

export function asPullRequestId(value: string): PullRequestId {
	return assertNonEmptyId(value, "pull request id") as PullRequestId;
}
