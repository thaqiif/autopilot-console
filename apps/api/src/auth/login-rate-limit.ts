/**
 * In-memory login rate limiter keyed by client identity (IP / device).
 * Clock-injectable for deterministic tests.
 */

export interface LoginRateLimiterOptions {
	maxAttempts: number;
	windowMs: number;
	now?: () => Date;
}

interface AttemptBucket {
	failures: number[];
}

export class LoginRateLimiter {
	private readonly maxAttempts: number;
	private readonly windowMs: number;
	private readonly now: () => Date;
	private readonly buckets = new Map<string, AttemptBucket>();

	constructor(options: LoginRateLimiterOptions) {
		this.maxAttempts = options.maxAttempts;
		this.windowMs = options.windowMs;
		this.now = options.now ?? (() => new Date());
	}

	/** True when the client is currently blocked. */
	isLimited(clientKey: string): boolean {
		this.prune(clientKey);
		const bucket = this.buckets.get(clientKey);
		if (!bucket) return false;
		return bucket.failures.length >= this.maxAttempts;
	}

	recordFailure(clientKey: string): void {
		const nowMs = this.now().getTime();
		const bucket = this.buckets.get(clientKey) ?? { failures: [] };
		bucket.failures.push(nowMs);
		this.buckets.set(clientKey, bucket);
		this.prune(clientKey);
	}

	recordSuccess(clientKey: string): void {
		this.buckets.delete(clientKey);
	}

	private prune(clientKey: string): void {
		const bucket = this.buckets.get(clientKey);
		if (!bucket) return;
		const cutoff = this.now().getTime() - this.windowMs;
		bucket.failures = bucket.failures.filter((ts) => ts > cutoff);
		if (bucket.failures.length === 0) {
			this.buckets.delete(clientKey);
		} else {
			this.buckets.set(clientKey, bucket);
		}
	}
}
