import postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

export interface DatabaseClient {
	sql: Sql;
	end: () => Promise<void>;
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
	if (!databaseUrl || databaseUrl.trim().length === 0) {
		throw new Error("databaseUrl is required");
	}
	const sql = postgres(databaseUrl, {
		max: 1,
		idle_timeout: 20,
		connect_timeout: 10,
		// Schema is recreated between tests; prepared statements cache column types.
		prepare: false,
		onnotice: () => {
			// silence DDL notices in tests
		},
	});
	return {
		sql,
		end: async () => {
			await sql.end({ timeout: 5 });
		},
	};
}
