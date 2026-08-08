/**
 * AutopilotRunner port — boundary between Console and the Autopilot engine.
 */

import type { ProcessIdentity } from "./process-identity";
import type { NormalizedRunResult, ProgressSnapshot } from "./result-normalizer";

export interface AutopilotStartRequest {
	projectRoot: string;
	/** Project-relative validated task path (never absolute). */
	taskRelativePath: string;
	projectId: string;
	featureId: string;
	expectedBranch: string;
	executablePath?: string;
	env?: Record<string, string>;
}

export interface AutopilotRunHandle {
	projectId: string;
	featureId: string;
	projectRoot: string;
	taskRelativePath: string;
	expectedBranch: string;
	processIdentity: ProcessIdentity;
	startedAt: string;
}

export interface RuntimeValidation {
	ok: boolean;
	message: string;
	executablePath?: string;
}

export interface TaskValidation {
	ok: boolean;
	message: string;
	checksum?: string;
}

export interface CommitObservation {
	hash: string;
	subject: string;
	authoredAt?: string;
}

export type SignalKind = "graceful" | "term" | "kill";

export interface WaitOptions {
	timeoutMs?: number;
}

export interface AutopilotRunner {
	validateRuntime(): Promise<RuntimeValidation>;
	validateTask(projectRoot: string, taskRelativePath: string): Promise<TaskValidation>;
	start(request: AutopilotStartRequest): Promise<AutopilotRunHandle>;
	isAlive(handle: AutopilotRunHandle): Promise<boolean>;
	signal(handle: AutopilotRunHandle, kind: SignalKind): Promise<void>;
	wait(handle: AutopilotRunHandle, options?: WaitOptions): Promise<NormalizedRunResult>;
	readProgress(projectRoot: string, taskRelativePath: string): Promise<ProgressSnapshot>;
	observeCommits(handle: AutopilotRunHandle): Promise<CommitObservation[]>;
}
