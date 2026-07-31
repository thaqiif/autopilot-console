# Deployment Guide

Production-oriented Compose deployment for Autopilot Console. Web/API, worker, and
PostgreSQL run as separate services with persistent storage and environment-based
secrets. Production composition wires concurrent development supervision, durable
cancel command consumption, PR handoff, and GitHub reconciliation into the worker.

## Prerequisites

- Docker 24+ and Docker Compose v2.20+
- Bun 1.3+ for local development and repository commands
- An absolute host workspace path for `WORKSPACE_MOUNT`
- An absolute `AUTOPILOTAGENT_MOUNT` directory containing executable `run.sh`;
  Compose mounts it read-only at `/opt/autopilotagent`
- Initialize Autopilotagent once for the mounted tool distribution before first use
  (`/opt/autopilotagent` must include the Autopilotagent CLI distribution)
- A configured agent CLI available to the worker as `AGENT_BIN`
- A GitHub token in `GH_TOKEN` or `GITHUB_TOKEN` for GitHub operations

## Startup

1. Copy `.env.example` to `.env`.
2. Replace the database, session, admin, GitHub, workspace, Autopilotagent, and
   agent CLI values. `SESSION_SECRET` must contain at least 16 characters and the
   admin password must satisfy the policy documented in `.env.example`.
3. Render and inspect the configuration:

   ```bash
   docker compose config
   ```

4. Build and start the stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

The one-shot `migrate` service applies the core migration followed by the
workflow migration under a PostgreSQL advisory lock. API and worker startup wait
for it to complete. To apply migrations explicitly:

```bash
docker compose run --rm migrate
```

Migrations are forward-only. Back up the database before upgrading.

## Services

| Service | Published port | Purpose |
| --- | ---: | --- |
| `web` | `${WEB_PORT:-80}` | React SPA served by unprivileged nginx on container port 8080 |
| `api` | `${API_PORT:-3000}` | Hono HTTP API |
| `worker` | none | Database-polling development worker |
| `postgres` | `${POSTGRES_PORT:-5432}` | PostgreSQL source of truth and queue |
| `migrate` | none | One-shot forward migration runner |

## Configuration and secrets

Required Compose values are `POSTGRES_PASSWORD`, `SESSION_SECRET`,
`ADMIN_BOOTSTRAP_PASSWORD`, and `AUTOPILOTAGENT_MOUNT`. Set at least one GitHub
token before enabling GitHub work. `WORKSPACE_MOUNT` defaults to `./projects`,
while `WORKSPACE_ROOTS` defaults to `/projects` inside the containers.

`AUTOPILOTAGENT_BIN` defaults to `/opt/autopilotagent/run.sh`. `AGENT_BIN` is
required by the worker and must resolve to an executable agent CLI on the worker
PATH or as an absolute path. Secrets are supplied through environment variables
or secret mounts; do not bake credentials into images or example values.

## Mounts and persistence

| Mount or volume | Access | Purpose |
| --- | --- | --- |
| `postgres-data` | PostgreSQL read/write | Database persistence |
| `${WORKSPACE_MOUNT}:/projects` | API read-only; worker read/write | Allowlisted project workspaces |
| `${AUTOPILOTAGENT_MOUNT}:/opt/autopilotagent` | API/worker read-only | External Autopilotagent runtime |
| `diagnostic-logs:/app/logs` | worker read/write | Bounded diagnostic file storage with retention |

The web service never receives host workspace mounts. API/web require no writable
access to project source.

## Health and TLS

- `GET /api/health/live` is the API liveness endpoint.
- `GET /api/health` reports database, worker heartbeat/capacity, Autopilot, and
  project-scoped GitHub access. Database failure produces `down`; another
  dependency failure produces `degraded`.
- `GET /health/live` on the worker (container-local port
  `${WORKER_HEALTH_PORT:-3001}`, not published) is the worker Compose probe.
- `GET /nginx-health` is the web-container health endpoint.

PostgreSQL, API, worker, and web have Compose health checks. Web waits for API
health; API and worker wait for healthy PostgreSQL and successful migrations.
Worker startup also validates `git`, `jq`, `gh`, `AGENT_BIN`, and the mounted
Autopilotagent runtime.

Terminate TLS at a trusted reverse proxy. Production cookies are marked `Secure`
from the API's production mode, so clients must use HTTPS through that proxy.

## Supported single-server performance profile

Phase 1 read-latency acceptance is measured against the **`phase-1-single-server`**
profile: API, worker, and PostgreSQL on one host via Docker Compose (or the
equivalent local Bun + local PostgreSQL layout used by the integration suite).

| Parameter | Value |
| --- | --- |
| Profile name | `phase-1-single-server` |
| Database | PostgreSQL 16 (local Docker Compose single-server) |
| Default connection | `postgres://…@127.0.0.1:5432/autopilot_console` |
| Seed scale | 10 projects, 100 releases, 500 non-archived features, four active jobs |
| Measured endpoints | authenticated `GET /api/overview` and `GET /api/features/:id` |
| Warm-up | discard first 5 samples per endpoint |
| Measured samples | 40 timed warm reads per endpoint after warm-up |
| Acceptance | at least 95% of samples under 1 second; report p95, sample count, warm-up policy, database profile, and failure diagnostics |
| Gate | measured sample ratio / p95 — not a longer test timeout |

Run the self-validating suite:

```bash
bun test tests/performance/portfolio-reads.test.ts
```

The suite verifies exact fixture cardinality before timing, records sample
count / warm-up policy / p95 / database profile on every run, and fails with
those diagnostics when the ratio budget is missed. Optimize projections or
indexes only when measured p95 exceeds the target on this profile.

## Observability

API and worker entrypoints emit redacted structured JSON logs with correlation,
project, feature, attempt/job, adapter, and worker context. Runtime metrics are
updated from real operations for:

- queue depth and oldest queued age
- active jobs and configured capacity
- registration heartbeat age
- job durations, starts, completions, failures, cancellations, and interruptions
- Git and GitHub adapter error counts
- GitHub polling lag
- attention pending and urgent counts

Diagnostic retention under `diagnostic-logs` enforces documented limits:

| Limit | Default | Purpose |
| --- | ---: | --- |
| max file body | 64 KiB (`64 * 1024`) | Per-write body cap with `…[TRUNCATED]` marker |
| max per attempt | 512 KiB (`512 * 1024`) | Cumulative attempt body budget with structured truncation records |
| max total volume | 32 MiB (`32 * 1024 * 1024`) | Oldest-first prune across the volume |
| max age | 7 days | Age-based prune of diagnostic files |

Structured progress and audit correlation fields (`projectId`, `featureId`,
`jobAttemptId`, `correlationId`) are preserved even when bodies are truncated.

## Current Phase 1 limitations

- Multi-replica workers share the database queue; capacity is per-registration.
- Aggregate release qualification and full owner-journey e2e remain separate
  Phase 1 requirements beyond production composition.

See the Phase 1 task ledger and progress notes under
`docs/autopilotagent/autopilot-console-phase-1` for the independently verifiable
requirements.
