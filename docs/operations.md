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

# Diagnostic logs (persisted volume with retention)
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

### Database Restore

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

## Cancellation and Escalation

### Cancelling a Running Job

Jobs can be cancelled from the web UI or API. Production composition consumes
durable `CANCEL_REQUESTED` commands on the owning worker:

1. API receives cancel intent and marks the feature transition
2. The worker job-command loop claims the owned attempt
3. Worker sends SIGUSR1 to the autopilotagent process
4. After the grace period, SIGTERM is sent to the process tree
5. If still alive after escalation, SIGKILL is sent
6. The attempt is marked cancelled and metrics record `job_cancel`

### Handling Interruptions

If the worker process dies unexpectedly:

1. On restart, the orphan reconciler scans for attempts marked as `running`
2. Processes without a live PID are marked as `interrupted`
3. Interrupted jobs can be retried from the web UI
4. Retry creates a new immutable attempt linked to the predecessor
5. Metrics record `job_interrupt` when an interrupted outcome is observed

### Process Tree Safety

- PID reuse is detected via `/proc/{pid}/stat` starttime comparison
- Cancellation never kills unrelated processes
- Escalation follows SIGUSR1 → SIGTERM → SIGKILL with grace periods

## Retry

Safe retries are worker-owned. The API records durable retry intent; the worker
verifies process-tree liveness before enqueueing a successor attempt. Retries
never re-use a process identity from a previous attempt.

## GitHub Reconciliation

Production workers compose PR handoff and GitHub reconciliation:

1. Durable `create_pr` outbox intents are claimed and processed by the handoff worker
2. Open pull requests are polled on the configured `GITHUB_POLL_INTERVAL`
3. Current-head CI and review observations update feature state monotonically
4. Adapter failures increment Git or GitHub error metrics and record polling lag
5. Stale observations cannot overwrite newer head or poll state

## Diagnostics and Retention

Worker diagnostic files live under `/app/logs` (Compose volume `diagnostic-logs`).
Every write is redacted before storage. Retention enforces:

- **Per-file body cap:** 64 KiB with an explicit `…[TRUNCATED]` marker
- **Per-attempt budget:** 512 KiB cumulative; further writes store structured
  truncation records that preserve `projectId`, `featureId`, `jobAttemptId`, and
  `correlationId` for progress and audit correlation
- **Total volume:** 32 MiB, oldest-first prune
- **Age:** 7 days

The worker prunes on a 60-second cadence and emits a structured log when files
are removed.

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
docker compose run --rm migrate

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

The `/api/health` endpoint returns a structured report. Worker detail fields are
the single documented contract for Settings: capacity, active jobs, heartbeat
age, queue depth, oldest queued age, and GitHub polling lag.

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "database": {
      "name": "database",
      "status": "ok",
      "detail": { "available": true }
    },
    "worker": {
      "name": "worker",
      "status": "ok",
      "detail": {
        "active": true,
        "capacity": 4,
        "activeJobs": 2,
        "availableSlots": 2,
        "lastHeartbeatAt": "2026-07-31T12:00:00.000Z",
        "heartbeatAge": 1500,
        "queueDepth": 3,
        "oldestQueuedAgeMs": 42000,
        "pollingLagMs": 900
      }
    },
    "autopilot": {
      "name": "autopilot",
      "status": "ok",
      "detail": { "available": true }
    },
    "github": {
      "name": "github",
      "status": "ok",
      "detail": {
        "authenticated": true,
        "projectAvailable": true,
        "repositoryReadable": true
      }
    },
    "checkedAt": "2026-07-31T12:00:00.000Z"
  }
}
```

Status values: `ok` (all healthy), `degraded` (partial), `down` (critical failure).
Settings maps these to accessible text: healthy, degraded, unavailable.
Queue depth and oldest age come from `development_job_attempts` with status
`QUEUED`. Polling lag is the age of the newest `pull_requests.last_observed_at`.

### Structured Logging

All services emit JSON-formatted log entries with:

- `timestamp` — ISO-8601 UTC
- `level` — debug, info, warn, error
- `message` — human-readable description
- `context` — correlation ID, project/feature/job identifiers, adapter, and
  worker identity (sensitive fields redacted)

### Metrics

Runtime metrics are updated from real API and worker operations, including queue
depth, active jobs, oldest queued age, heartbeat age, job durations,
interruptions, Git/GitHub adapter errors, polling lag, and attention counts.
Metrics appear in worker structured logs (`worker metrics`) and inform health
probes that observe registration heartbeat, capacity, queue depth, oldest queued
age, and GitHub polling lag.

## Phase 1 release qualification

Phase 1 qualification status: NOT QUALIFIED

Operators claim Phase 1 release qualification only after the documented command
passes twice consecutively:

```bash
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/autopilot_console}"
bun run verify:phase-1
bun run verify:phase-1
```

The command fails closed when Bun, PostgreSQL, the Docker CLI, Playwright
Chromium, or any named gate (typecheck, lint, unit, database, process, browser,
coverage, build, migrations, image, compose, deployment-smoke) is missing,
skipped, unavailable, or failing. Inspect `phase-1-qualification-summary.json`
for the machine-readable gate report. Align status claims with the requirement
ledger, README, deployment guide, and changelog — do not report qualification
when any critical test was skipped or opt-in.
