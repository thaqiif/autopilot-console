import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, type DatabaseClient, type Sql } from "../client";
import {
	createAdminAccount,
	createFeature,
	createProject,
	createPullRequestIdentity,
	createRelease,
	createSession,
	createTaskApproval,
	createWorkspace,
	getWorkspace,
} from "../repositories/core-repositories";
import { applyCoreMigration, rollbackCoreMigration } from "../schema/core-migration";
import { createDatabaseFixture, type DatabaseFixture } from "../testing/database-fixture";
import { DATABASE_URL, mustReject, resetSchema } from "../testing/test-helpers";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = join(packageRoot, "migrations");

let client: DatabaseClient;
let sql: Sql;
let fixture: DatabaseFixture;

beforeAll(async () => {
	client = createDatabaseClient(DATABASE_URL);
	sql = client.sql;
	await resetSchema(sql);
	await applyCoreMigration(sql);
});

afterAll(async () => {
	await client.end();
});

async function ensureCoreSchema(): Promise<void> {
	const tables = await sql`
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'workspaces'
	`;
	if (tables.length === 0) {
		await applyCoreMigration(sql);
	}
}

beforeEach(async () => {
	await ensureCoreSchema();
	// Truncate data only — keep DDL stable for the suite.
	await sql.unsafe(`
		TRUNCATE TABLE
			pull_requests,
			task_approvals,
			features,
			releases,
			projects,
			sessions,
			admin_accounts,
			workspaces
		RESTART IDENTITY CASCADE
	`);
	fixture = createDatabaseFixture(sql);
});

describe("core schema migration", () => {
	test("migration file 0001_core_entities.sql exists and applies cleanly", async () => {
		const files = await readdir(migrationsDir);
		expect(files).toContain("0001_core_entities.sql");
		const body = await readFile(join(migrationsDir, "0001_core_entities.sql"), "utf8");
		expect(body.length).toBeGreaterThan(100);
		await expect(applyCoreMigration(sql)).resolves.toBeUndefined();
	});

	test("rollback removes core tables then reapply restores them", async () => {
		await rollbackCoreMigration(sql);
		const afterRollback = await sql`
			SELECT tablename FROM pg_tables WHERE schemaname = 'public'
		`;
		const names = afterRollback.map((r) => r.tablename as string);
		expect(names).not.toContain("workspaces");
		expect(names).not.toContain("projects");
		expect(names).not.toContain("features");

		await applyCoreMigration(sql);
		const afterApply = await sql`
			SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
		`;
		const restored = afterApply.map((r) => r.tablename as string);
		expect(restored).toContain("workspaces");
		expect(restored).toContain("admin_accounts");
		expect(restored).toContain("sessions");
		expect(restored).toContain("projects");
		expect(restored).toContain("releases");
		expect(restored).toContain("features");
		expect(restored).toContain("task_approvals");
		expect(restored).toContain("pull_requests");
	});
});

describe("workspace and administrator", () => {
	test("exactly one implicit workspace row can be ensured", async () => {
		const ws = await createWorkspace(sql);
		expect(ws.id).toBeTruthy();
		const again = await createWorkspace(sql);
		expect(again.id).toBe(ws.id);
		const rows = await sql`SELECT count(*)::int AS n FROM workspaces`;
		expect(rows[0]?.n).toBe(1);
		const loaded = await getWorkspace(sql);
		expect(loaded?.id).toBe(ws.id);
	});

	test("administrator account stores only password hash, never plaintext", async () => {
		const admin = await createAdminAccount(sql, {
			username: "admin",
			passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc",
		});
		expect(admin.username).toBe("admin");
		expect(admin.passwordHash).toContain("argon2");
		const raw = await sql`SELECT * FROM admin_accounts WHERE id = ${admin.id}`;
		const row = raw[0] as Record<string, unknown>;
		expect(row.password_hash).toBeDefined();
		expect(JSON.stringify(row)).not.toContain("plaintext");
		// unique username
		await mustReject(() =>
			createAdminAccount(sql, {
				username: "admin",
				passwordHash: "$argon2id$other",
			}),
		);
	});

	test("sessions are revocable and expire with timezone-aware UTC timestamps", async () => {
		const admin = await createAdminAccount(sql, {
			username: "admin",
			passwordHash: "$argon2id$hash",
		});
		const session = await createSession(sql, {
			adminAccountId: admin.id,
			tokenHash: "hash-1",
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
		});
		expect(session.revokedAt).toBeNull();
		expect(session.expiresAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");

		const col = await sql`
			SELECT data_type, udt_name
			FROM information_schema.columns
			WHERE table_name = 'sessions' AND column_name = 'expires_at'
		`;
		expect(col[0]?.data_type).toBe("timestamp with time zone");

		await sql`
			UPDATE sessions SET revoked_at = now() WHERE id = ${session.id}
		`;
		const revoked = await sql`SELECT revoked_at FROM sessions WHERE id = ${session.id}`;
		expect(revoked[0]?.revoked_at).not.toBeNull();
	});
});

describe("project uniqueness and archival", () => {
	test("active projects enforce unique name, slug, github identity, and canonical path", async () => {
		const ws = await createWorkspace(sql);
		const a = await createProject(sql, {
			workspaceId: ws.id,
			name: "Alpha",
			slug: "alpha",
			githubOwner: "acme",
			githubRepo: "alpha",
			canonicalPath: "/workspaces/alpha",
			developmentBranch: "main",
		});
		expect(a.status).toBe("active");

		await mustReject(() =>
			createProject(sql, {
				workspaceId: ws.id,
				name: "Alpha",
				slug: "alpha-2",
				githubOwner: "acme",
				githubRepo: "other",
				canonicalPath: "/workspaces/alpha-2",
				developmentBranch: "main",
			}),
		);

		await mustReject(() =>
			createProject(sql, {
				workspaceId: ws.id,
				name: "Alpha Two",
				slug: "alpha",
				githubOwner: "acme",
				githubRepo: "other",
				canonicalPath: "/workspaces/alpha-2",
				developmentBranch: "main",
			}),
		);

		await mustReject(() =>
			createProject(sql, {
				workspaceId: ws.id,
				name: "Alpha Three",
				slug: "alpha-3",
				githubOwner: "acme",
				githubRepo: "alpha",
				canonicalPath: "/workspaces/alpha-3",
				developmentBranch: "main",
			}),
		);

		await mustReject(() =>
			createProject(sql, {
				workspaceId: ws.id,
				name: "Alpha Four",
				slug: "alpha-4",
				githubOwner: "acme",
				githubRepo: "alpha-4",
				canonicalPath: "/workspaces/alpha",
				developmentBranch: "main",
			}),
		);
	});

	test("archived projects preserve history and free uniqueness for a new active project", async () => {
		const ws = await createWorkspace(sql);
		const archived = await createProject(sql, {
			workspaceId: ws.id,
			name: "Legacy",
			slug: "legacy",
			githubOwner: "acme",
			githubRepo: "legacy",
			canonicalPath: "/workspaces/legacy",
			developmentBranch: "main",
		});
		await sql`UPDATE projects SET status = 'archived', archived_at = now() WHERE id = ${archived.id}`;

		const replacement = await createProject(sql, {
			workspaceId: ws.id,
			name: "Legacy",
			slug: "legacy",
			githubOwner: "acme",
			githubRepo: "legacy",
			canonicalPath: "/workspaces/legacy",
			developmentBranch: "main",
		});
		expect(replacement.id).not.toBe(archived.id);
		expect(replacement.status).toBe("active");

		const stillThere = await sql`SELECT id, status FROM projects WHERE id = ${archived.id}`;
		expect(stillThere[0]?.status).toBe("archived");
	});
});

describe("release and feature hierarchy uniqueness", () => {
	test("releases enforce project-scoped name/version uniqueness", async () => {
		const { projectA, projectB } = await fixture.twoProjects();
		const r1 = await createRelease(sql, {
			projectId: projectA.id,
			name: "1.0.0",
			version: "1.0.0",
			sortOrder: 1,
		});
		expect(r1.projectId).toBe(projectA.id);

		await mustReject(() =>
			createRelease(sql, {
				projectId: projectA.id,
				name: "1.0.0",
				version: "1.0.0",
				sortOrder: 2,
			}),
		);

		// Same name/version allowed on another project
		const other = await createRelease(sql, {
			projectId: projectB.id,
			name: "1.0.0",
			version: "1.0.0",
			sortOrder: 1,
		});
		expect(other.projectId).toBe(projectB.id);
	});

	test("features enforce project-scoped slug uniqueness even across releases", async () => {
		const { projectA } = await fixture.twoProjects();
		const rel1 = await createRelease(sql, {
			projectId: projectA.id,
			name: "A",
			version: "1.0.0",
			sortOrder: 1,
		});
		const rel2 = await createRelease(sql, {
			projectId: projectA.id,
			name: "B",
			version: "2.0.0",
			sortOrder: 2,
		});
		const f1 = await createFeature(sql, {
			projectId: projectA.id,
			releaseId: rel1.id,
			slug: "login",
			title: "Login",
			branchName: "feature/f1-login",
		});
		expect(f1.slug).toBe("login");
		expect(f1.state).toBe("PLANNED");

		await mustReject(() =>
			createFeature(sql, {
				projectId: projectA.id,
				releaseId: rel2.id,
				slug: "login",
				title: "Login again",
				branchName: "feature/f2-login",
			}),
		);
	});

	test("foreign keys prevent cross-project release/feature association", async () => {
		const { projectA, projectB } = await fixture.twoProjects();
		const releaseB = await createRelease(sql, {
			projectId: projectB.id,
			name: "B",
			version: "1.0.0",
			sortOrder: 1,
		});

		await mustReject(() =>
			createFeature(sql, {
				projectId: projectA.id,
				releaseId: releaseB.id,
				slug: "cross",
				title: "Cross",
				branchName: "feature/cross",
			}),
		);
	});
});

describe("task approvals and pull request identity", () => {
	test("task approval snapshots are immutable and bound to project/feature hierarchy", async () => {
		const { projectA, projectB, featureA } = await fixture.featureReady();
		const admin = await createAdminAccount(sql, {
			username: "owner",
			passwordHash: "$argon2id$x",
		});
		const approval = await createTaskApproval(sql, {
			projectId: projectA.id,
			featureId: featureA.id,
			relativeTaskPath: "docs/tasks.json",
			checksum: "abc123",
			schemaCompatibilityVersion: "1",
			requirementsSnapshot: { requirements: [{ id: "1" }] },
			approvedByAdminId: admin.id,
		});
		expect(approval.checksum).toBe("abc123");

		const mutateErr = await mustReject(async () => {
			await sql`UPDATE task_approvals SET checksum = ${"mutated"} WHERE id = ${approval.id}`;
		});
		expect(mutateErr.message).toContain("immutable");

		const featureB = await fixture.featureInProject(projectB.id, "other");
		await mustReject(() =>
			createTaskApproval(sql, {
				projectId: projectA.id,
				featureId: featureB.id,
				relativeTaskPath: "docs/tasks.json",
				checksum: "zzz",
				schemaCompatibilityVersion: "1",
				requirementsSnapshot: { requirements: [] },
				approvedByAdminId: approval.approvedByAdminId,
			}),
		);
	});

	test("pull request identity fields are immutable separately from observations", async () => {
		const { projectA, featureA } = await fixture.featureReady();
		const pr = await createPullRequestIdentity(sql, {
			projectId: projectA.id,
			featureId: featureA.id,
			repositoryOwner: "acme",
			repositoryName: "alpha",
			number: 42,
			url: "https://github.com/acme/alpha/pull/42",
			headBranch: "feature/f1-login",
			baseBranch: "main",
			originalHeadSha: "deadbeef".repeat(5),
		});
		expect(pr.number).toBe(42);

		const numberErr = await mustReject(async () => {
			await sql`UPDATE pull_requests SET number = ${99} WHERE id = ${pr.id}`;
		});
		expect(numberErr.message).toContain("immutable");
		await mustReject(async () => {
			await sql`UPDATE pull_requests SET head_branch = ${"other"} WHERE id = ${pr.id}`;
		});
		await mustReject(async () => {
			await sql`UPDATE pull_requests SET url = ${"https://evil.example/pr/1"} WHERE id = ${pr.id}`;
		});
		await mustReject(async () => {
			await sql`UPDATE pull_requests SET repository_owner = ${"evil"} WHERE id = ${pr.id}`;
		});
		await mustReject(async () => {
			await sql`UPDATE pull_requests SET base_branch = ${"develop"} WHERE id = ${pr.id}`;
		});
		await mustReject(async () => {
			await sql`UPDATE pull_requests SET original_head_sha = ${"cafebabe"} WHERE id = ${pr.id}`;
		});

		await sql`
			UPDATE pull_requests
			SET observed_head_sha = ${"a".repeat(40)},
			    observed_state = ${"open"},
			    last_observed_at = now()
			WHERE id = ${pr.id}
		`;
		const observed =
			await sql`SELECT observed_head_sha, observed_state FROM pull_requests WHERE id = ${pr.id}`;
		expect(observed[0]?.observed_head_sha).toBe("a".repeat(40));
		expect(observed[0]?.observed_state).toBe("open");
	});

	test("pull request cannot reference feature from another project", async () => {
		const { projectB, featureA } = await fixture.featureReady();
		await mustReject(() =>
			createPullRequestIdentity(sql, {
				projectId: projectB.id,
				featureId: featureA.id,
				repositoryOwner: "acme",
				repositoryName: "alpha",
				number: 7,
				url: "https://github.com/acme/alpha/pull/7",
				headBranch: "feature/x",
				baseBranch: "main",
				originalHeadSha: "b".repeat(40),
			}),
		);
	});
});

describe("UTC timestamps and transaction isolation", () => {
	test("all core entity timestamp columns are timestamptz", async () => {
		const rows = await sql`
			SELECT table_name, column_name, data_type
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND column_name IN ('created_at', 'updated_at', 'archived_at', 'expires_at', 'revoked_at', 'approved_at', 'last_observed_at', 'last_validated_at')
			ORDER BY table_name, column_name
		`;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.data_type).toBe("timestamp with time zone");
		}
	});

	test("transaction rollback leaves no partial domain mutation", async () => {
		const ws = await createWorkspace(sql);
		const err = await mustReject(async () => {
			await sql.begin(async (tx) => {
				await createProject(tx as unknown as Sql, {
					workspaceId: ws.id,
					name: "RollbackMe",
					slug: "rollback-me",
					githubOwner: "acme",
					githubRepo: "rollback",
					canonicalPath: "/workspaces/rollback",
					developmentBranch: "main",
				});
				throw new Error("force rollback");
			});
		});
		expect(err.message).toContain("force rollback");

		const count = await sql`SELECT count(*)::int AS n FROM projects WHERE slug = 'rollback-me'`;
		expect(count[0]?.n).toBe(0);
	});
});
