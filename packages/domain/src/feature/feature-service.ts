/**
 * Transactional feature planning: create/update, ownership guards, audit (F-4).
 */

import type { Queryable, TransactionSql } from "../../../database/src/client";
import {
	appendActivityEvent,
	appendAuditEvent,
	type FeatureRow,
	findFeatureByProjectSlug,
	getFeatureById,
	getProjectById,
	getReleaseById,
	createFeature as insertFeature,
	updateFeature as updateFeatureRow,
} from "../../../database/src/index";
import { generateFeatureBranch, sanitizeSlug } from "../../../shared/src/git/feature-branch";
import type { ProjectActor } from "../project/project";
import type { Feature } from "./feature";

export type FeatureMutationFailureReason =
	| "VALIDATION_FAILED"
	| "UNIQUENESS_VIOLATION"
	| "CROSS_PROJECT"
	| "NOT_FOUND"
	| "ALREADY_ARCHIVED";

export type CreateFeatureResult =
	| { ok: true; feature: Feature }
	| { ok: false; reason: FeatureMutationFailureReason; message: string };

export type UpdateFeatureResult =
	| { ok: true; feature: Feature }
	| { ok: false; reason: FeatureMutationFailureReason; message: string };

export interface FeatureServiceOptions {
	sql: Queryable;
	now?: () => Date;
	/** Optional id factory for deterministic branch generation before insert. */
	newId?: () => string;
}

export interface FeatureService {
	createFeature(input: {
		projectId: string;
		releaseId: string;
		title: string;
		slug: string;
		summary?: string;
		actor: ProjectActor;
	}): Promise<CreateFeatureResult>;
	updateFeature(input: {
		featureId: string;
		title?: string;
		slug?: string;
		summary?: string | null;
		actor: ProjectActor;
	}): Promise<UpdateFeatureResult>;
	getFeature(input: { featureId: string }): Promise<Feature | null>;
}

type TxCapable = Queryable & {
	begin?: <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;
};

function mapRow(row: FeatureRow): Feature {
	return {
		id: row.id,
		projectId: row.projectId,
		releaseId: row.releaseId,
		slug: row.slug,
		title: row.title,
		summary: row.summary,
		state: row.state,
		branchName: row.branchName,
		taskPath: row.taskPath,
		rowVersion: row.rowVersion,
		archivedAt: row.archivedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function featureSnapshot(feature: Feature): Record<string, unknown> {
	return {
		id: feature.id,
		projectId: feature.projectId,
		releaseId: feature.releaseId,
		slug: feature.slug,
		title: feature.title,
		summary: feature.summary,
		state: feature.state,
		branchName: feature.branchName,
		taskPath: feature.taskPath,
		archivedAt: feature.archivedAt?.toISOString() ?? null,
	};
}

function isUniqueViolation(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: string; message?: string };
	return e.code === "23505" || /unique|duplicate/i.test(e.message ?? "");
}

function isCrossProjectViolation(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { message?: string };
	return /release .* does not belong to project|does not exist/i.test(e.message ?? "");
}

async function withTransaction<T>(sql: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
	const capable = sql as TxCapable;
	if (typeof capable.begin === "function") {
		return capable.begin((tx) => fn(tx));
	}
	return fn(sql);
}

function normalizeSlug(raw: string): string {
	try {
		return sanitizeSlug(raw);
	} catch {
		return raw.trim().toLowerCase();
	}
}

export function createFeatureService(options: FeatureServiceOptions): FeatureService {
	const newId = options.newId ?? (() => crypto.randomUUID());

	return {
		async getFeature(input) {
			const row = await getFeatureById(options.sql, input.featureId);
			return row ? mapRow(row) : null;
		},

		async createFeature(input) {
			const title = input.title.trim();
			const slug = normalizeSlug(input.slug);
			if (!title || !slug) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "feature.create",
						targetType: "feature",
						targetId: "pending",
						projectId: input.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: { reason: "VALIDATION_FAILED", title, slug },
					});
				});
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					message: "Feature title and slug are required",
				};
			}

			const project = await getProjectById(options.sql, input.projectId);
			if (!project) {
				return { ok: false, reason: "NOT_FOUND", message: "Project not found" };
			}

			const release = await getReleaseById(options.sql, input.releaseId);
			if (!release) {
				return { ok: false, reason: "NOT_FOUND", message: "Release not found" };
			}
			if (release.projectId !== input.projectId) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "feature.create",
						targetType: "feature",
						targetId: "pending",
						projectId: input.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: {
							reason: "CROSS_PROJECT",
							projectId: input.projectId,
							releaseId: input.releaseId,
							releaseProjectId: release.projectId,
						},
					});
				});
				return {
					ok: false,
					reason: "CROSS_PROJECT",
					message: "Release does not belong to the given project",
				};
			}

			const slugHit = await findFeatureByProjectSlug(options.sql, {
				projectId: input.projectId,
				slug,
			});
			if (slugHit) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "feature.create",
						targetType: "feature",
						targetId: "pending",
						projectId: input.projectId,
						correlationId: input.actor.correlationId,
						result: "rejected",
						nextValues: { reason: "UNIQUENESS_VIOLATION", slug },
					});
				});
				return {
					ok: false,
					reason: "UNIQUENESS_VIOLATION",
					message: "A feature with this slug already exists in the project",
				};
			}

			const featureId = newId();
			let branchName: string;
			try {
				branchName = generateFeatureBranch({ featureId, slug });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Invalid feature branch";
				return { ok: false, reason: "VALIDATION_FAILED", message };
			}

			try {
				const feature = await withTransaction(options.sql, async (tx) => {
					const row = await insertFeature(tx, {
						id: featureId,
						projectId: input.projectId,
						releaseId: input.releaseId,
						slug,
						title,
						summary: input.summary,
						branchName,
						state: "PLANNED",
					});
					const mapped = mapRow(row);
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "feature.create",
						targetType: "feature",
						targetId: mapped.id,
						projectId: mapped.projectId,
						featureId: mapped.id,
						correlationId: input.actor.correlationId,
						result: "success",
						nextValues: { feature: featureSnapshot(mapped) },
					});
					await appendActivityEvent(tx, {
						projectId: mapped.projectId,
						featureId: mapped.id,
						type: "feature.created",
						summary: `Feature ${mapped.slug} created`,
						source: "domain",
						metadata: {
							featureId: mapped.id,
							releaseId: mapped.releaseId,
							branchName: mapped.branchName,
						},
					});
					return mapped;
				});
				return { ok: true, feature };
			} catch (err) {
				if (isCrossProjectViolation(err)) {
					return {
						ok: false,
						reason: "CROSS_PROJECT",
						message: "Release does not belong to the given project",
					};
				}
				if (isUniqueViolation(err)) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						message: "A feature with this slug already exists in the project",
					};
				}
				throw err;
			}
		},

		async updateFeature(input) {
			const existing = await getFeatureById(options.sql, input.featureId);
			if (!existing) {
				return { ok: false, reason: "NOT_FOUND", message: "Feature not found" };
			}
			if (existing.archivedAt) {
				return {
					ok: false,
					reason: "ALREADY_ARCHIVED",
					message: "Feature is archived",
				};
			}

			const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
			const nextSlug = input.slug !== undefined ? normalizeSlug(input.slug) : existing.slug;
			const nextSummary = input.summary !== undefined ? input.summary : existing.summary;

			if (!nextTitle || !nextSlug) {
				await withTransaction(options.sql, async (tx) => {
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "feature.update",
						targetType: "feature",
						targetId: existing.id,
						projectId: existing.projectId,
						featureId: existing.id,
						correlationId: input.actor.correlationId,
						result: "rejected",
						priorValues: featureSnapshot(mapRow(existing)),
						nextValues: { reason: "VALIDATION_FAILED", title: nextTitle, slug: nextSlug },
					});
				});
				return {
					ok: false,
					reason: "VALIDATION_FAILED",
					message: "Feature title and slug are required",
				};
			}

			if (nextSlug !== existing.slug) {
				const hit = await findFeatureByProjectSlug(options.sql, {
					projectId: existing.projectId,
					slug: nextSlug,
				});
				if (hit && hit.id !== existing.id) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						message: "A feature with this slug already exists in the project",
					};
				}
			}

			try {
				const feature = await withTransaction(options.sql, async (tx) => {
					const row = await updateFeatureRow(tx, {
						id: existing.id,
						title: nextTitle,
						slug: nextSlug,
						summary: nextSummary,
					});
					const mapped = mapRow(row);
					await appendAuditEvent(tx, {
						actorType: input.actor.actorType,
						actorId: input.actor.actorId,
						action: "feature.update",
						targetType: "feature",
						targetId: mapped.id,
						projectId: mapped.projectId,
						featureId: mapped.id,
						correlationId: input.actor.correlationId,
						result: "success",
						priorValues: featureSnapshot(mapRow(existing)),
						nextValues: { feature: featureSnapshot(mapped) },
					});
					await appendActivityEvent(tx, {
						projectId: mapped.projectId,
						featureId: mapped.id,
						type: "feature.updated",
						summary: `Feature ${mapped.slug} updated`,
						source: "domain",
						metadata: { featureId: mapped.id },
					});
					return mapped;
				});
				return { ok: true, feature };
			} catch (err) {
				if (isUniqueViolation(err)) {
					return {
						ok: false,
						reason: "UNIQUENESS_VIOLATION",
						message: "A feature with this slug already exists in the project",
					};
				}
				throw err;
			}
		},
	};
}
