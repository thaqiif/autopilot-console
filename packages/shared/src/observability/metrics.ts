/**
 * Runtime metrics for queue depth, active jobs, heartbeat age, durations,
 * interruptions, adapter errors, polling lag, and attention counts.
 *
 * Metrics are collected in-memory and exported as a snapshot for health
 * endpoints and structured logging. All values are redaction-safe numbers.
 */

export interface QueueMetrics {
	depth: number;
	oldestAge: number;
}

export interface WorkerMetrics {
	activeJobs: number;
	maxConcurrentJobs: number;
	heartbeatAge: number;
}

export interface AdapterMetrics {
	githubErrors: number;
	gitErrors: number;
	pollingLag: number;
}

export interface JobMetrics {
	totalStarted: number;
	totalCompleted: number;
	totalFailed: number;
	totalCancelled: number;
	totalInterrupted: number;
	averageDuration: number;
}

export interface AttentionMetrics {
	pendingCount: number;
	urgentCount: number;
}

export interface MetricsSnapshot {
	collectedAt: string;
	queue: QueueMetrics;
	worker: WorkerMetrics;
	adapters: AdapterMetrics;
	jobs: JobMetrics;
	attention: AttentionMetrics;
}

export interface MetricsCollector {
	snapshot(): MetricsSnapshot;
	setQueueDepth(depth: number, oldestAge: number): void;
	setActiveJobs(count: number, maxConcurrent: number): void;
	setHeartbeatAge(age: number): void;
	incrementAdapterError(kind: "github" | "git"): void;
	setPollingLag(lag: number): void;
	recordJobStart(): void;
	recordJobComplete(): void;
	recordJobFail(): void;
	recordJobCancel(): void;
	recordJobInterrupt(): void;
	recordJobDuration(duration: number): void;
	setAttentionCounts(pending: number, urgent: number): void;
}

export interface MetricsCollectorOptions {
	now?: () => Date;
}

export function createMetricsCollector(options: MetricsCollectorOptions = {}): MetricsCollector {
	const now = options.now ?? (() => new Date());

	let queueDepth = 0;
	let oldestAge = 0;
	let activeJobs = 0;
	let maxConcurrentJobs = 0;
	let heartbeatAge = 0;
	let githubErrors = 0;
	let gitErrors = 0;
	let pollingLag = 0;
	let totalStarted = 0;
	let totalCompleted = 0;
	let totalFailed = 0;
	let totalCancelled = 0;
	let totalInterrupted = 0;
	let totalDuration = 0;
	let durationSamples = 0;
	let pendingCount = 0;
	let urgentCount = 0;

	return {
		snapshot(): MetricsSnapshot {
			return {
				collectedAt: now().toISOString(),
				queue: { depth: queueDepth, oldestAge },
				worker: { activeJobs, maxConcurrentJobs, heartbeatAge },
				adapters: { githubErrors, gitErrors, pollingLag },
				jobs: {
					totalStarted,
					totalCompleted,
					totalFailed,
					totalCancelled,
					totalInterrupted,
					averageDuration: durationSamples > 0 ? totalDuration / durationSamples : 0,
				},
				attention: { pendingCount, urgentCount },
			};
		},
		setQueueDepth(depth: number, age: number) {
			queueDepth = depth;
			oldestAge = age;
		},
		setActiveJobs(count: number, maxConcurrent: number) {
			activeJobs = count;
			maxConcurrentJobs = maxConcurrent;
		},
		setHeartbeatAge(age: number) {
			heartbeatAge = age;
		},
		incrementAdapterError(kind: "github" | "git") {
			if (kind === "github") githubErrors++;
			else gitErrors++;
		},
		setPollingLag(lag: number) {
			pollingLag = lag;
		},
		recordJobStart() {
			totalStarted++;
		},
		recordJobComplete() {
			totalCompleted++;
		},
		recordJobFail() {
			totalFailed++;
		},
		recordJobCancel() {
			totalCancelled++;
		},
		recordJobInterrupt() {
			totalInterrupted++;
		},
		recordJobDuration(duration: number) {
			totalDuration += duration;
			durationSamples++;
		},
		setAttentionCounts(pending: number, urgent: number) {
			pendingCount = pending;
			urgentCount = urgent;
		},
	};
}
