/**
 * Transactional release planning: create/update/archive, progress, audit (F-3).
 */

import type { Queryable } from "../../../database/src/client";
import {
	appendActivityEvent,
	appendAuditEvent,
	archiveRelease as archiveReleaseRow,
	countActiveAttemptsForRelease,
	findReleaseByProjectNameVersion,
	getProjectById,
	getReleaseById,
	createRelease as insertRelease,
	listFeaturesByRelease,
	listReleasesByProject,
	nextReleaseSortOrder,
	type ReleaseRow,
	updateRelease as updateReleaseRow,
} from "../../../database/src/index";
import type { ProjectActor } from "../project/project";
import { isUniqueViolation, withTransaction } from "../shared/transaction";
import { computeDevelopmentProgress, type DevelopmentProgress } from "./development-progress";
import type { Release } from "./release";

export type ReleaseMutationFailureReason =
	| "VALIDATION_FAILED"
	| "UNIQUENESS_VIOLATION"
	| "ACTIVE_JOBS"
	| "NOT_FOUND"
	| "ALREADY_ARCHIVED";

export type CreateReleaseResult =
	| { ok: true; release: Release }
	| { ok: false; reason: ReleaseMutationFailureReason; message: string };

export type UpdateReleaseResult =
	| { ok: true; release: Release }
	| { ok: false; reason: ReleaseMutationFailureReason; message: string };

export type ArchiveReleaseResult =
	| { ok: true; release: Release }
	| { ok: false; reason: ReleaseMutationFailureReason; message: string };

export type ReleaseProgressResult =
	| { ok: true; release: Release; progress: DevelopmentProgress }
	| { ok: false; reason: ReleaseMutationFailureReason; message: string };

export interface ReleaseServiceOptions {
	sql: Queryable;
	now?: () => Date;
}

export interface ReleaseService {
	createRelease(input: {
		projectId: string;
		name: string;
		version: string;
		description?: string;
		sortOrder?: number;
		actor: ProjectActor;
	}): Promise<CreateReleaseResult>;
	updateRelease(input: {
		releaseId: string;
		name?: string;
		version?: string;
		description?: string | null;
		sortOrder?: number;
		actor: ProjectActor;
	}): Promise<UpdateReleaseResult>;
	archiveRelease(input: { releaseId: string; actor: ProjectActor }): Promise<ArchiveReleaseResult>;
	listReleases(input: { projectId: string }): Promise<Release[]>;
	getReleaseProgress(input: { releaseId: string }): Promise<ReleaseProgressResult>;
}

function mapRow(row: ReleaseRow): Release {
	return {
		id: row.id,
		projectId: row.projectId,
		name: row.name,
		version: row.version,
		description: row.description,
		sortOrder: row.sortOrder,
		status: row.status,
		archivedAt: row.archivedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function releaseSnapshot(release: Release): Record<string, unknown> {
	return {
		id: release.id,
		projectId: release.projectId,
		name: release.name,
		version: release.version,
		description: release.description,
		sortOrder: release.sortOrder,
		status: release.status,
		archivedAt: release.archivedAt?.toISOString() ?? null,
	};
}

export function createReleaseService(options: ReleaseServiceOptions): ReleaseService {
	const now = options.now ?? (() => new Date());

	return {
		async listReleases(input) {
			const rows = await listReleasesByProject(options.sql, input.projectId);
			return rows.map(mapRow);
		},

		async getReleaseProgress(input) {
			const row = await getReleaseById(options.sql, input.releaseId);
			if (!row) {
				return { ok: false, reason: "NOT_FOUND", message: "Release not found" };
			}
			const features = await listFeaturesByRelease(options.sql, row.id);
			const progress = computeDevelopmentProgress(
				features.map((f) => ({
					id: f.id,
					state: f.state,
					archived: f.archivedAt !== null,
				})),
			);
			return { ok: true, release: mapRow(row), progress };
		},

		async createRelease(input) {
			const name = input.name.trim();
			const version = input.version.trim();
			if (!name || !version) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "release.create",
						targetType: "release",
						targetId: "pending",
						projectId: input.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: {
							reason: "VALIDATION_FAILED",
							name,
							version,
						},
					});
				});
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					message: "Release name and version are required",
				};
			}

			const project = await getProjectById(options.sql, input.projectId);
			if (!project) {
				return { ok: false, reason: "NOT_FOUND", message: "Project not found" };
			}

			const existing = await findReleaseByProjectNameVersion(options.sql, {
				projectId: input.projectId,
				name,
				version,
			});
			if (existing) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "release.create",
						targetType: "release",
						targetId: "pending",
						projectId: input.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: {
							reason: "UNIQUENESS_VIOLATION",
							name,
							version,
						},
					});
				});
				return {
					ok: false,
					reason: "UNIQUENESS_VIOLATION",
					message: "A release with this name and version already exists in the project",
				};
			}

			const sortOrder =
				input.sortOrder !== undefined
					? input.sortOrder
					: await nextReleaseSortOrder(options.sql, input.projectId);

			try {
				const release = await withTransaction(options.sql, async (tx) => {
					const row = await insertRelease(tx, {
						projectId: input.projectId,
						name,
						version,
						description: input.description,
						sortOrder,
					});
					const mapped = mapRow(row);
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "release.create",
						targetType: "release",
						targetId: mapped.id,
						projectId: mapped.projectId,
						correlationId: input.actor.correlationId,
						result: "success",
						nextValues: { release: releaseSnapshot(mapped) },
					});
					await appendActivityEvent(tx, {
						projectId: mapped.projectId,
						type: "release.created",
						summary: `Release ${mapped.version} created`,
						source: "domain",
						metadata: { releaseId: mapped.id, name: mapped.name, version: mapped.version },
					});
					return mapped;
				});
				return { ok: true, release };
			} catch (err) {
				if (isUniqueViolation(err)) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						message: "A release with this name and version already exists in the project",
					};
				}
				throw err;
			}
		},

		async updateRelease(input) {
			const existing = await getReleaseById(options.sql, input.releaseId);
			if (!existing) {
				return { ok: false, reason: "NOT_FOUND", message: "Release not found" };
			}
			if (existing.archivedAt) {
				return {
					ok: false,
					reason: "ALREADY_ARCHIVED",
					message: "Release is archived",
				};
			}

			const nextName = input.name !== undefined ? input.name.trim() : existing.name;
			const nextVersion = input.version !== undefined ? input.version.trim() : existing.version;
			const nextDescription =
				input.description !== undefined ? input.description : existing.description;
			const nextSort = input.sortOrder ?? existing.sortOrder;

			if (!nextName || !nextVersion) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "release.update",
						targetType: "release",
						targetId: existing.id,
						projectId: existing.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						priorValues: releaseSnapshot(mapRow(existing)),
						nextValues: { reason: "VALIDATION_FAILED", name: nextName, version: nextVersion },
					});
				});
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					message: "Release name and version are required",
				};
			}

			if (nextName !== existing.name || nextVersion !== existing.version) {
				const conflict = await findReleaseByProjectNameVersion(options.sql, {
					projectId: existing.projectId,
					name: nextName,
					version: nextVersion,
				});
				if (conflict && conflict.id !== existing.id) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						message: "A release with this name and version already exists in the project",
					};
				}
			}

			try {
				const release = await withTransaction(options.sql, async (tx) => {
					const row = await updateReleaseRow(tx, {
						id: existing.id,
						name: nextName,
						version: nextVersion,
						description: nextDescription,
						sortOrder: nextSort,
					});
					const mapped = mapRow(row);
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "release.update",
						targetType: "release",
						targetId: mapped.id,
						projectId: mapped.projectId,
						correlationId: input.actor.correlationId,
						result: "success",
						priorValues: releaseSnapshot(mapRow(existing)),
						nextValues: { release: releaseSnapshot(mapped) },
					});
					await appendActivityEvent(tx, {
						projectId: mapped.projectId,
						type: "release.updated",
						summary: `Release ${mapped.version} updated`,
						source: "domain",
						metadata: { releaseId: mapped.id },
					});
					return mapped;
				});
				return { ok: true, release };
			} catch (err) {
				if (isUniqueViolation(err)) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						message: "A release with this name and version already exists in the project",
					};
				}
				throw err;
			}
		},

		async archiveRelease(input) {
			const existing = await getReleaseById(options.sql, input.releaseId);
			if (!existing) {
				return { ok: false, reason: "NOT_FOUND", message: "Release not found" };
			}
			if (existing.archivedAt) {
				return {
					ok: false,
					reason: "ALREADY_ARCHIVED",
					message: "Release is already archived",
				};
			}

			const active = await countActiveAttemptsForRelease(options.sql, existing.id);
			if (active > 0) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "release.archive",
						targetType: "release",
						targetId: existing.id,
						projectId: existing.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						priorValues: releaseSnapshot(mapRow(existing)),
						nextValues: { reason: "ACTIVE_JOBS", activeJobs: active },
					});
				});
				return {
					ok: false,
					reason: "ACTIVE_JOBS",
					message: "Queued or active feature jobs prevent release archival",
				};
			}

			const archivedAt = now();
			const release = await withTransaction(options.sql, async (tx) => {
				const row = await archiveReleaseRow(tx, { id: existing.id, archivedAt });
				const mapped = mapRow(row);
				await appendAuditEvent(tx, {
					actorType: input.actor.actorType,
					actorId: input.actor.actorId,
					action: "release.archive",
					targetType: "release",
					targetId: mapped.id,
					projectId: mapped.projectId,
					correlationId: input.actor.correlationId,
					result: "success",
					priorValues: releaseSnapshot(mapRow(existing)),
					nextValues: releaseSnapshot(mapped),
				});
				await appendActivityEvent(tx, {
					projectId: mapped.projectId,
					type: "release.archived",
					summary: `Release ${mapped.version} archived`,
					source: "domain",
					metadata: { releaseId: mapped.id },
				});
				return mapped;
			});
			return { ok: true, release };
		},
	};
}
