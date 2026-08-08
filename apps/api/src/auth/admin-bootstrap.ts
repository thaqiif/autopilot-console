/**
 * Bootstrap at most one administrator from deployment password config.
 */

import {
	type AdminAccountRow,
	countAdminAccounts,
	createAdminAccount,
	getAdminAccountByUsername,
	type Queryable,
	revokeSessionsForAdmin,
	updateAdminPasswordHash,
} from "../../../../packages/database/src/index";
import { hashPassword } from "./password";

export interface BootstrapAdminInput {
	username: string;
	bootstrapPassword: string;
	/** When true and the sole admin already exists, rotate the password hash. */
	rotatePassword?: boolean;
	now?: () => Date;
}

export async function bootstrapAdministrator(
	sql: Queryable,
	input: BootstrapAdminInput,
): Promise<AdminAccountRow> {
	const username = input.username.trim();
	if (username.length === 0) {
		throw new Error("Administrator username is required");
	}

	// Strength check before any DB write (hashPassword also checks).
	const passwordHash = await hashPassword(input.bootstrapPassword);
	const existingCount = await countAdminAccounts(sql);
	const existing = await getAdminAccountByUsername(sql, username);

	if (existing) {
		if (input.rotatePassword) {
			const updated = await updateAdminPasswordHash(sql, {
				id: existing.id,
				passwordHash,
			});
			await revokeSessionsForAdmin(sql, {
				adminAccountId: existing.id,
				revokedAt: (input.now ?? (() => new Date()))(),
			});
			return updated;
		}
		// Idempotent re-bootstrap with same username: return existing row.
		return existing;
	}

	if (existingCount > 0) {
		throw new Error("A single administrator already exists; cannot create another account");
	}

	return createAdminAccount(sql, { username, passwordHash });
}
