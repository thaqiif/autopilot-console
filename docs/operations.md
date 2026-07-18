# Operations Guide

## Day-to-Day Operations

### Checking System Health

```bash
# Full readiness report
curl http://localhost:3000/api/health

# Quick liveness check
curl http://localhost:3000/api/health/live

# Docker service status
docker compose ps
```

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f worker
docker compose logs -f api

# Diagnostic logs (persisted volume)
docker compose exec worker ls /app/logs
```

## Backup and Recovery

### Database Backup

```bash
# Full database dump
docker compose exec postgres pg_dump -U autopilot autopilot > backup-$(date +%Y%m%d).sql

# Compressed backup
docker compose exec postgres pg_dump -U autopilot autopilot | gzip > backup-$(date +%Y%m%d).sql.gz
```

### Database Recovery

```bash
# Restore from backup
cat backup-20260101.sql | docker compose exec -T postgres psql -U autopilot autopilot

# Restore compressed backup
zcat backup-20260101.sql.gz | docker compose exec -T postgres psql -U autopilot autopilot
```

### Volume Backup

```bash
# Backup postgres volume
docker run --rm -v autopilot-console_postgres-data:/data -v $(pwd):/backup alpine \
    tar czf /backup/postgres-data-$(date +%Y%m%d).tar.gz -C /data .
```

## Cancellation and Interruption Handling

### Cancelling a Running Job

Jobs can be cancelled from the web UI or API. The cancellation process:

1. API receives cancel intent and marks the feature transition
2. Worker sends SIGUSR1 to the autopilotagent process
3. After grace period, SIGTERM is sent to the process tree
4. If still alive after escalation, SIGKILL is sent
5. The attempt is marked as cancelled and the feature returns to the queue

### Handling Interruptions

If the worker process dies unexpectedly:

1. On restart, the orphan reconciler scans for attempts marked as `running`
2. Processes without a live PID are marked as `interrupted`
3. Interrupted jobs can be retried from the web UI
4. Retry creates a new immutable attempt linked to the predecessor

### Process Tree Safety

- PID reuse is detected via `/proc/{pid}/stat` starttime comparison
- Cancellation never kills unrelated processes
- Escalation follows SIGUSR1 → SIGTERM → SIGKILL with grace periods

## Safe Upgrades

### Pre-Upgrade Checklist

1. **Back up the database** (see Backup section above)
2. **Check running jobs** — cancel or wait for completion
3. **Review the changelog** for breaking changes

### Upgrade Steps

```bash
# 1. Pull latest code
git pull origin main

# 2. Rebuild images
docker compose build

# 3. Stop the stack (preserves volumes)
docker compose down

# 4. Run any pending migrations
docker compose up -d postgres
sleep 5
docker compose exec postgres pg_isready
docker compose run --rm api bun run packages/database/src/migrate.ts

# 5. Start the full stack
docker compose up -d

# 6. Verify health
curl http://localhost:3000/api/health
```

### Rollback

If an upgrade causes issues:

```bash
# Stop the new version
docker compose down

# Restore database from backup
cat backup-YYYYMMDD.sql | docker compose exec -T postgres psql -U autopilot autopilot

# Checkout the previous version
git checkout <previous-tag>

# Rebuild and restart
docker compose build
docker compose up -d
```

## Worker Tooling

The worker container includes:

- **autopilotagent** — autonomous TDD execution engine
- **git** — version control operations
- **gh** — GitHub CLI for PR and CI operations
- **jq** — JSON processing for task file manipulation
- **Agent CLI** — configured via `AGENT_BIN` environment variable

### Verifying Worker Tools

```bash
docker compose exec worker git --version
docker compose exec worker jq --version
docker compose exec worker gh --version
```

## Monitoring

### Health Endpoint Response

The `/api/health` endpoint returns a structured report:

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "database": { "name": "database", "status": "ok" },
    "worker": { "name": "worker", "status": "ok" },
    "autopilot": { "name": "autopilot", "status": "ok" },
    "github": { "name": "github", "status": "ok" },
    "checkedAt": "2026-01-15T12:00:00.000Z"
  }
}
```

Status values: `ok` (all healthy), `degraded` (partial), `down` (critical failure).

### Structured Logging

All services emit JSON-formatted log entries with:

- `timestamp` — ISO-8601 UTC
- `level` — debug, info, warn, error
- `message` — human-readable description
- `context` — correlation ID, project/feature/job identifiers (sensitive fields redacted)

### Metrics

The worker exposes runtime metrics including queue depth, active jobs, heartbeat age, adapter errors, polling lag, and attention counts. Metrics are available through the health endpoints and structured logs.
