import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "../client";

const WORKFLOW_VERSION = "0002_workflow_records";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = join(packageRoot, "migrations", `${WORKFLOW_VERSION}.sql`);

async function loadMigrationSql(): Promise<string> {
	return readFile(migrationPath, "utf8");
}

export async function applyWorkflowMigration(sql: Sql): Promise<void> {
	await sql.unsafe('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

	const tables = await sql`
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'schema_migrations'
	`;
	if (tables.length > 0) {
		const rows = await sql`
			SELECT version FROM schema_migrations WHERE version = ${WORKFLOW_VERSION}
		`;
		if (rows.length > 0) {
			return;
		}
	}

	const body = await loadMigrationSql();
	await sql.unsafe(body);
}

export async function rollbackWorkflowMigration(sql: Sql): Promise<void> {
	await sql.unsafe(`
		DROP TABLE IF EXISTS idempotency_records CASCADE;
		DROP TABLE IF EXISTS outbox_intents CASCADE;
		DROP TABLE IF EXISTS scheduled_reconciliation_jobs CASCADE;
		DROP TABLE IF EXISTS audit_events CASCADE;
		DROP TABLE IF EXISTS activity_events CASCADE;
		DROP TABLE IF EXISTS failure_records CASCADE;
		DROP TABLE IF EXISTS diagnostic_log_chunks CASCADE;
		DROP TABLE IF EXISTS progress_snapshots CASCADE;
		DROP TABLE IF EXISTS development_job_attempts CASCADE;
		DROP TABLE IF EXISTS worker_registrations CASCADE;
		DROP TYPE IF EXISTS audit_actor_type CASCADE;
		DROP TYPE IF EXISTS diagnostic_stream CASCADE;
		DROP TYPE IF EXISTS schedule_status CASCADE;
		DROP TYPE IF EXISTS outbox_status CASCADE;
		DROP TYPE IF EXISTS job_attempt_status CASCADE;
		DROP FUNCTION IF EXISTS enforce_attempt_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS enforce_progress_snapshot_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS prevent_progress_snapshot_mutation() CASCADE;
		DROP FUNCTION IF EXISTS enforce_diagnostic_log_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS prevent_diagnostic_log_mutation() CASCADE;
		DROP FUNCTION IF EXISTS enforce_failure_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS prevent_failure_mutation() CASCADE;
		DROP FUNCTION IF EXISTS enforce_activity_hierarchy() CASCADE;
		DROP FUNCTION IF EXISTS prevent_activity_mutation() CASCADE;
		DROP FUNCTION IF EXISTS prevent_audit_mutation() CASCADE;
		DELETE FROM schema_migrations WHERE version = '${WORKFLOW_VERSION}';
	`);
}

export { WORKFLOW_VERSION };
