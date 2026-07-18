import {
	createWorkerRegistration,
	heartbeatWorker,
	type Queryable,
	type WorkerRegistrationRow,
} from "../../../../packages/database/src/index";

export interface WorkerRegistrationService {
	register(): Promise<WorkerRegistrationRow>;
	heartbeat(workerRegistrationId: string, activeJobs?: number): Promise<WorkerRegistrationRow>;
}

export interface WorkerRegistrationServiceOptions {
	sql: Queryable;
	workerId: string;
	hostname: string;
	capacity?: number;
}

export function createWorkerRegistrationService(
	options: WorkerRegistrationServiceOptions,
): WorkerRegistrationService {
	return {
		register: () =>
			createWorkerRegistration(options.sql, {
				workerId: options.workerId,
				hostname: options.hostname,
				capacity: options.capacity,
			}),
		heartbeat: (workerRegistrationId, activeJobs) =>
			heartbeatWorker(options.sql, workerRegistrationId, { activeJobs }),
	};
}
