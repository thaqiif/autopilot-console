import { applyCoreMigration, applyWorkflowMigration, createDatabaseClient } from "./index";

const MIGRATION_LOCK_ID = 7_160_051_021;

export async function migrate(databaseUrl: string): Promise<void> {
	const client = createDatabaseClient(databaseUrl);
	try {
		await client.sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
		try {
			await applyCoreMigration(client.sql);
			await applyWorkflowMigration(client.sql);
		} finally {
			await client.sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
		}
	} finally {
		await client.end();
	}
}

if (import.meta.main) {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	await migrate(databaseUrl);
}
