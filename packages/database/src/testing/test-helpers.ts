/**
 * Shared test utilities for database-backed integration tests.
 *
 * Centralizes duplicated patterns found across 12+ test files:
 *   - DATABASE_URL constant
 *   - Schema reset SQL (DROP/CREATE/GRANT)
 *   - mustReject async assertion helper
 *   - Controllable FakeClock for time-dependent tests
 *
 * All utilities are pure TS and require no runtime dependencies beyond bun:test.
 */

import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "../client";

/** Default connection string for isolated PostgreSQL test databases. */
export const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgres://postgres:postgres@autopilot-console-pg:5432/autopilot_console";

/** Reset the public schema before applying migrations. */
export const SCHEMA_RESET_SQL = [
	"DROP SCHEMA IF EXISTS public CASCADE",
	"CREATE SCHEMA public",
	"GRANT ALL ON SCHEMA public TO postgres",
	"GRANT ALL ON SCHEMA public TO public",
];

/** Execute schema reset statements in order. */
export async function resetSchema(sql: { unsafe(query: string): Promise<unknown> }): Promise<void> {
	for (const stmt of SCHEMA_RESET_SQL) {
		await sql.unsafe(stmt);
	}
}

export interface IsolatedTestDatabase extends DatabaseClient {
	readonly schema: string;
}

/**
 * Create a database client whose objects live in a unique PostgreSQL schema.
 * The schema is dropped when the client ends, allowing integration suites to
 * migrate and mutate concurrently without resetting shared public state.
 */
export async function createIsolatedTestDatabase(
	databaseUrl = DATABASE_URL,
): Promise<IsolatedTestDatabase> {
	const schema = `autopilot_test_${randomUUID().replaceAll("-", "")}`;
	const control = createDatabaseClient(databaseUrl);
	let isolated: DatabaseClient | undefined;
	try {
		await control.sql`CREATE SCHEMA ${control.sql(schema)}`;
		isolated = createDatabaseClient(databaseUrl, { schema });
		const [{ current_schema: activeSchema } = {}] = await isolated.sql`
			SELECT current_schema()
		`;
		if (activeSchema !== schema) {
			throw new Error("Failed to select isolated PostgreSQL test schema");
		}
		return {
			schema,
			sql: isolated.sql,
			end: async () => {
				await isolated?.end();
				await control.sql`DROP SCHEMA IF EXISTS ${control.sql(schema)} CASCADE`;
				await control.end();
			},
		};
	} catch (error) {
		await isolated?.end();
		await control.sql`DROP SCHEMA IF EXISTS ${control.sql(schema)} CASCADE`.catch(() => {});
		await control.end();
		throw error;
	}
}

/**
 * Assert that a promise rejects. Returns the error so callers can inspect
 * its message or type. Throws if the promise resolves (test failure).
 */
export async function mustReject(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected operation to reject");
}

// ── FakeClock ────────────────────────────────────────────────────────────────

export interface FakeClock {
	/** Current time as a Date. */
	now(): Date;
	/** Advance the clock by the given number of milliseconds. */
	advanceMs(ms: number): void;
	/** Set the clock to a specific ISO-8601 timestamp. */
	set(iso: string): void;
	/** Return a stable bound copy of `now` for use in callback props. */
	boundNow(): () => Date;
}

/**
 * Create a controllable fake clock starting at the given ISO timestamp.
 *
 * The returned clock is mutable — call advanceMs or set to move time forward.
 * boundNow() returns a stable function reference so it can be passed as a
 * service dependency without leaking the mutable clock object.
 */
export function createFakeClock(initialIso = "2026-07-18T00:00:00.000Z"): FakeClock {
	let currentMs = Date.parse(initialIso);
	const clock: FakeClock = {
		now: () => new Date(currentMs),
		advanceMs: (ms: number) => {
			currentMs += ms;
		},
		set: (iso: string) => {
			currentMs = Date.parse(iso);
		},
		boundNow: () => clock.now,
	};
	return clock;
}

/**
 * Convenience: create a minimal clock-like object matching the
 * `{ now: () => Date; advanceMs: (ms: number) => void }` shape used by
 * `apps/api/src/testing/api-fixture.ts`.
 */
export function createApiCompatibleClock(initialIso = "2026-07-18T00:00:00.000Z"): {
	now: () => Date;
	advanceMs: (ms: number) => void;
} {
	return createFakeClock(initialIso);
}
