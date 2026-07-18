# Deployment Guide

## Prerequisites

- **Docker** 24+ and **Docker Compose** v2.20+
- **Bun** 1.3+ (for local development and initialization)
- **autopilotagent** CLI (for the worker to execute autonomous TDD sessions)
- **PostgreSQL** 16+ (handled by Compose, or use an external instance)
- **GitHub CLI** (`gh`) authenticated with a token that has `repo` scope

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/thaqiif/autopilot-console.git
   cd autopilot-console
   ```

2. Copy the environment template and fill in secrets:
   ```bash
   cp .env.example .env
   # Edit .env — set POSTGRES_PASSWORD, SESSION_SECRET, ADMIN_BOOTSTRAP_PASSWORD, GH_TOKEN
   ```

3. Initialize Bun and install dependencies (required for build):
   ```bash
   bun install
   ```

4. Start the stack:
   ```bash
   docker compose up -d
   ```

5. Run database migrations (first deploy only):
   ```bash
   docker compose exec api bun run packages/database/src/migrate.ts
   ```

6. Open http://localhost (or your configured WEB_PORT) and log in with the admin bootstrap password.

## Architecture

| Service   | Port | Description |
|-----------|------|-------------|
| `web`     | 80   | React SPA served by nginx, proxies `/api/*` to the API service |
| `api`     | 3000 | Hono REST API — authentication, CRUD, health, SSE events |
| `worker`  | 3001 | Background job processor — runs autopilotagent, Git, and GitHub operations |
| `postgres`| 5432 | PostgreSQL 16 — source of truth and job queue |

## Environment Configuration

All secrets are passed via environment variables. **Never bake secrets into images.**

### Required Variables

| Variable | Description | Minimum Length |
|----------|-------------|----------------|
| `POSTGRES_PASSWORD` | Database password | 8 |
| `SESSION_SECRET` | HTTP session signing key | 16 |
| `ADMIN_BOOTSTRAP_PASSWORD` | Initial admin password | 12 (upper+lower+digit+special) |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub API token with `repo` scope | — |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `autopilot` | Database name |
| `POSTGRES_USER` | `autopilot` | Database user |
| `POSTGRES_PORT` | `5432` | Host port for PostgreSQL |
| `WEB_PORT` | `80` | Host port for web UI |
| `API_PORT` | `3000` | Host port for API |
| `WORKER_PORT` | `3001` | Host port for worker |
| `WORKSPACE_ROOTS` | `/projects` | Comma-separated allowed workspace paths inside the worker |
| `WORKSPACE_MOUNT` | `./projects` | Host path mounted into the worker container |
| `MAX_CONCURRENT_JOBS` | `4` | Maximum parallel development jobs |
| `GITHUB_POLL_INTERVAL_SECONDS` | `60` | CI/review polling interval |
| `AUTOPILOTAGENT_BIN` | `autopilotagent` | Path to autopilotagent binary |
| `AGENT_BIN` | `cmd` | Agent identifier for autopilotagent |

## Secrets Management

Secrets are provided through environment variables or Docker secrets:

- **Environment variables**: Set in `.env` file (gitignored) or passed via `docker compose --env-file`
- **Docker secrets**: For production, mount secret files and reference them via `_FILE` suffix conventions

Secrets are **never** included in:
- Docker images (no COPY of .env)
- Example configuration files (.env.example contains only placeholders)
- Application logs (automatic redaction via structured logger)
- Health/readiness responses (redacted before serialization)

## Volumes

| Volume | Service | Description |
|--------|---------|-------------|
| `postgres-data` | postgres | Persistent database storage |
| `diagnostic-logs` | worker | Bounded diagnostic and audit logs |
| `${WORKSPACE_MOUNT}` | worker | Host project workspace (bind mount) |

## Health Checks

All services expose health endpoints:

- **API**: `GET /api/health` — full readiness report (database, worker, autopilot, GitHub)
- **API**: `GET /api/health/live` — liveness probe
- **Web**: `GET /nginx-health` — nginx liveness

Compose uses `pg_isready` for PostgreSQL health and chains `depends_on` with `condition: service_healthy` to ensure correct startup order.

## TLS / HTTPS

The stack assumes a trusted TLS-terminating reverse proxy in front. For production:

1. Place a reverse proxy (nginx, Caddy, Traefik, or cloud LB) in front of the web service
2. Set `Secure` flag on session cookies by ensuring `X-Forwarded-Proto: https` is forwarded
3. The web service proxies `/api/*` to the API container internally (no TLS needed between containers)

## Database Migrations

Migrations are managed by the `packages/database` module:

```bash
# Run pending migrations
docker compose exec api bun run packages/database/src/migrate.ts

# Check migration status
docker compose exec api bun run packages/database/src/migrate.ts --status
```

Always back up the database before running migrations in production.
