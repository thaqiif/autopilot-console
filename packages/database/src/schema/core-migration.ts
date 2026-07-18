import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "../client";

const CORE_VERSION = "0001_core_entities";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = join(packageRoot, "migrations", `${CORE_VERSION}.sql`);

async function loadMigrationSql(): Promise<string> {
	return readFile(migrationPath, "utf8");
}

export async function applyCoreMigration(sql: Sql): Promise<void> {
	// Ensure pgcrypto/uuid generation available
	await sql.unsafe('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

	const applied = await sql`
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'schema_migrations'
	`;
	if (applied.length > 0) {
		const rows = await sql`
			SELECT version FROM schema_migrations WHERE version = ${CORE_VERSION}
		`;
		if (rows.length > 0) {
			return;
		}
	}

	const body = await loadMigrationSql();
	await sql.unsafe(body);
}

export async function rollbackCoreMigration(sql: Sql): Promise<void> {
	// Drop in dependency order; CASCADE covers triggers/functions/indexes.
	await sql.unsafe(`
		DROP TABLE IF EXISTS pull_requests CASCADE;
		DROP TABLE IF EXISTS task_approvals CASCADE;
		DROP TABLE IF EXISTS features CASCADE;
		DROP TABLE IF EXISTS releases CASCADE;
		DROP TABLE IF EXISTS projects CASCADE;
		DROP TABLE IF EXISTS sessions CASCADE;
		DROP TABLE IF EXISTS admin_accounts CASCADE;
		DROP TABLE IF EXISTS workspaces CASCADE;
		DROP TYPE IF EXISTS pull_request_observed_state CASCADE;
		DROP TYPE IF EXISTS feature_state CASCADE;
		DROP TYPE IF EXISTS release_status CASCADE;
		DROP TYPE IF EXISTS project_status CASCADE;
		DROP FUNCTION IF EXISTS enforce_feature_release_project() CASCADE;
		DROP FUNCTION IF EXISTS enforce_task_approval_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS prevent_task_approval_mutation() CASCADE;
		DROP FUNCTION IF EXISTS enforce_pull_request_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS prevent_pull_request_identity_mutation() CASCADE;
		DELETE FROM schema_migrations WHERE version = '${CORE_VERSION}';
	`);
}

export { CORE_VERSION };
