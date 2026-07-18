export interface GitHubBackoffState {
	featureId: string;
	consecutiveErrors: number;
	lastError: string | null;
	lastErrorAt: Date | null;
	backoffUntil: Date | null;
}

export interface GitHubBackoffOptions {
	maxConsecutiveErrors?: number;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
	now?: () => Date;
}

export function computeBackoff(
	state: GitHubBackoffState,
	options: GitHubBackoffOptions = {},
): { shouldBackoff: boolean; backoffMs: number } {
	const {
		maxConsecutiveErrors = 5,
		baseBackoffMs = 30_000,
		maxBackoffMs = 600_000,
		now = () => new Date(),
	} = options;

	if (state.consecutiveErrors === 0) {
		return { shouldBackoff: false, backoffMs: 0 };
	}

	if (state.backoffUntil && state.backoffUntil > now()) {
		return { shouldBackoff: true, backoffMs: state.backoffUntil.getTime() - now().getTime() };
	}

	const backoffMs = Math.min(baseBackoffMs * 2 ** (state.consecutiveErrors - 1), maxBackoffMs);

	return {
		shouldBackoff: state.consecutiveErrors >= maxConsecutiveErrors,
		backoffMs,
	};
}

export function shouldReportStaleSync(
	state: GitHubBackoffState,
	maxConsecutiveErrors: number,
): boolean {
	return state.consecutiveErrors >= maxConsecutiveErrors;
}
