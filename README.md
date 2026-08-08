# Autopilot Console

Autopilot Console is a Bun/TypeScript monorepo for managing projects, releases,
feature tasks, development attempts, and GitHub handoff from a React UI. It
contains a Hono API, PostgreSQL-backed workflow services, a development worker,
and an nginx-served web application.

## Current status

Phase 1 qualification status: QUALIFIED

Phase 1 was release-qualified on 2026-08-08 after `bun run verify:phase-1`
passed twice consecutively in a clean Docker-enabled environment. That command
is the single aggregate gate for workspace typecheck, lint, unit tests, database
integration, process and API suites, browser E2E, critical coverage, production
builds, migrations, image/Compose validation, and deployment smoke checks. It
fails closed when any required dependency or critical test is missing, skipped,
or failing.

The Phase 1 terminal product state remains **Development Merged** — Console never
claims a Phase 1 release is production-released. See the requirement ledger under
`docs/autopilotagent/autopilot-console-phase-1` for the independently verifiable
requirement set and its notes file for the current completed IDs.

## Repository layout

- `apps/api` — Hono routes and production server composition
- `apps/web` — React/Vite SPA and Playwright tests
- `apps/worker` — development queue and process control
- `packages` — domain, database, integrations, configuration, and shared code
- `tests` — repository architecture, integration, performance, and composition checks
- `scripts/verify-phase-1.ts` — Phase 1 release-qualification command
- `docs/deployment.md` — deployment prerequisites, startup, qualification, and limitations
- `docs/operations.md` — health, backup, upgrade, recovery, and qualification procedures

## Phase 1 release qualification

One documented command runs every required gate:

```bash
bun install --frozen-lockfile
# PostgreSQL must be reachable (default DATABASE_URL below)
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/autopilot_console}"
bun run verify:phase-1
# Re-run once to confirm consecutive success (no flake)
bun run verify:phase-1
```

Required dependencies (the command fails with an actionable message if any are
absent):

| Dependency | Purpose |
| --- | --- |
| Bun 1.3+ | Workspace runtime and test runner |
| PostgreSQL | Database integration, migrations, deployment smoke |
| Docker CLI + Compose v2.20+ | Image graph validation and Compose config |
| Playwright Chromium | Browser E2E (`apps/web` Playwright suite) |

Critical installed-CLI, database, process, browser, migration, image, and
deployment tests are never skipped or opt-in when qualification is claimed. A
machine-readable summary is written to `phase-1-qualification-summary.json`.

## Local checks

Install the locked workspace dependencies with Bun 1.3+, then run individual
loops as needed:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run coverage:critical
cd apps/web && bun run e2e
```

Database-backed API and worker tests require a reachable PostgreSQL instance and
the repository test database environment. Playwright starts Vite for the web
package E2E suite; composition journeys under `tests/e2e` use the real API and
PostgreSQL with fake external adapters.

## Compose

Copy `.env.example` to `.env` and set strong credentials, a workspace mount, a
GitHub token, and an absolute `AUTOPILOTAGENT_MOUNT` containing executable
`run.sh`. Then inspect and start the stack:

```bash
docker compose config
docker compose up -d --build
```

Read [the deployment guide](docs/deployment.md) before startup and [the operations
guide](docs/operations.md) before handling data or upgrades. Use
`bun run verify:phase-1` before claiming a Phase 1 release is qualified.
