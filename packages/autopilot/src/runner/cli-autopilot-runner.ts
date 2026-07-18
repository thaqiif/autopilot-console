/**
 * CLI adapter implementing AutopilotRunner against the global autopilotagent.
 * Intentionally incomplete until GREEN phase.
 */

import type {
	AutopilotRunner,
	AutopilotRunHandle,
	AutopilotStartRequest,
	CommitObservation,
	RuntimeValidation,
	SignalKind,
	TaskValidation,
	WaitOptions,
} from "./autopilot-runner";
import type { ProgressSnapshot, NormalizedRunResult } from "./result-normalizer";

export type {
	AutopilotRunner,
	AutopilotRunHandle,
	AutopilotStartRequest,
	CommitObservation,
	RuntimeValidation,
	SignalKind,
	TaskValidation,
	WaitOptions,
} from "./autopilot-runner";

export interface CliAutopilotRunnerOptions {
	executablePath?: string;
	envAllowlist?: string[];
	maxDiagnosticBytes?: number;
}

export class CliAutopilotRunner implements AutopilotRunner {
	constructor(_options: CliAutopilotRunnerOptions = {}) {}

	async validateRuntime(): Promise<RuntimeValidation> {
		throw new Error("not implemented: CliAutopilotRunner.validateRuntime");
	}

	async validateTask(
		_projectRoot: string,
		_taskRelativePath: string,
	): Promise<TaskValidation> {
		throw new Error("not implemented: CliAutopilotRunner.validateTask");
	}

	async start(_request: AutopilotStartRequest): Promise<AutopilotRunHandle> {
		throw new Error("not implemented: CliAutopilotRunner.start");
	}

	async isAlive(_handle: AutopilotRunHandle): Promise<boolean> {
		throw new Error("not implemented: CliAutopilotRunner.isAlive");
	}

	async signal(_handle: AutopilotRunHandle, _kind: SignalKind): Promise<void> {
		throw new Error("not implemented: CliAutopilotRunner.signal");
	}

	async wait(
		_handle: AutopilotRunHandle,
		_options?: WaitOptions,
	): Promise<NormalizedRunResult> {
		throw new Error("not implemented: CliAutopilotRunner.wait");
	}

	async readProgress(
		_projectRoot: string,
		_taskRelativePath: string,
	): Promise<ProgressSnapshot> {
		throw new Error("not implemented: CliAutopilotRunner.readProgress");
	}

	async observeCommits(
		_handle: AutopilotRunHandle,
	): Promise<CommitObservation[]> {
		throw new Error("not implemented: CliAutopilotRunner.observeCommits");
	}
}
