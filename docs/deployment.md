# Deployment Guide

Production-oriented Compose deployment scaffolding for Autopilot Console.
Web/API, worker, and PostgreSQL run as separate services with persistent storage
and environment-based secrets. The stack is not yet Phase 1 qualified; the
limitations below must be closed before treating it as production-ready.

## Prerequisites

- Docker 24+ and Docker Compose v2.20+
- Bun 1.3+ for local development and repository commands
- An absolute host workspace path for `WORKSPACE_MOUNT`
- An absolute `AUTOPILOTAGENT_MOUNT` directory containing executable `run.sh`;
  Compose mounts it read-only at `/opt/autopilotagent`
- A configured agent CLI available to the worker as `AGENT_BIN`
- A GitHub token in `GH_TOKEN` or `GITHUB_TOKEN` for GitHub operations
- Initialize Autopilotagent once for the mounted tool distribution before first use

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

## Observability

API and worker entrypoints emit redacted structured JSON logs. The shared metrics
collector can represent queue depth, active jobs, oldest age, heartbeat age,
durations, interruptions, adapter errors, polling lag, and attention counts.
The production worker supervisor heartbeats the actual active-job count and
configured capacity as ownership rises and falls. Complete adapter/error and
attention context propagation remain open requirements.

## Current Phase 1 limitations

- The production development worker supervises up to four concurrent
  different-project runs with accurate registration heartbeats; cancellation
  consumption and PR runtime composition remain separate requirements.
- Running cancellation commands are recorded by the API but are not consumed by
  an owning-worker cancellation loop.
- PR handoff and GitHub reconciliation components exist but are not composed into
  `apps/worker/src/main.ts`.
- Worker health completeness, deployment smoke tests, and aggregate release
  qualification remain open.

See the Phase 1 task ledger and progress notes under
`docs/autopilotagent/autopilot-console-phase-1` for the independently verifiable
requirements.
