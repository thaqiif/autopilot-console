# Changelog

## 2026-08-08

Phase 1 qualification status: NOT QUALIFIED

### Added

- Isolated desktop/mobile Playwright qualification with complete keyboard and WCAG 2.2 AA journeys.
- Istanbul source instrumentation enforcing at least 90% branch coverage independently for all 19 critical modules.
- Fresh-volume Compose qualification with live health probes and PostgreSQL dump/restore recovery verification.

### Changed

- Release qualification now requires a live Docker daemon, materializes every image, executes the installed Autopilotagent CLI contract automatically, and fails closed when any dependency is unavailable.

## 2026-07-31

### Added
- Phase 1 release-qualification command (`bun run verify:phase-1` / `scripts/verify-phase-1.ts`) that runs every named gate (dependencies, typecheck, lint, unit, database, process, browser, coverage, build, migrations, image, compose, deployment-smoke), fails closed on missing or skipped critical tests, and emits a machine-readable summary (requirement 48).
- Real browser/API/worker dispose-recreate durability suite with hold-gated push, PR-create, and poll restart boundaries (requirement 42).

### Added
- Phase 1 quality proof suites and critical coverage gates (requirement 31).

### Added

- Production Compose deployment wiring for separate web/API, worker, and PostgreSQL services with migration gating, health checks, persistent database and diagnostic volumes, and worker-only workspace mounts.
- Structured JSON logging and runtime metrics emission from API and worker entrypoints, plus bounded diagnostic file retention under the worker diagnostic volume.
- Worker startup validation for the mounted Autopilotagent runtime and configured agent CLI (`AGENT_BIN`).
- Feature task-path attachment and structured task review with checksum-aware Approve & Queue Development confirmation, lifecycle-gated replace/invalidate/reapprove actions, and status icons shared with progress views.

### Changed

- Deployment and operations docs now describe wired observability, diagnostic retention, trusted TLS proxy/Secure cookies, and agent CLI prerequisites.
- Feature detail now resolves project display names and posts confirmed project/feature targets with operation keys for approval, invalidation, and task replacement.
- Phase 1 task requirements 21–31 were decomposed into bounded requirements
  21–48, separating completed components from production composition and
  release qualification. Completion notes and operator documentation now state
  the remaining runtime limitations explicitly.

## 2026-07-19

### Added

- Executable Hono API and development-worker entrypoints, automatic forward
  migrations, persisted reads and SSE replay, and database-backed dependency
  health probes.
- Session restoration, server-issued session-bound CSRF grants, CSRF-aware web
  API calls, and functional project/release/feature create and edit forms.
- React/Vite application shell, portfolio/project/release/feature screens,
  task/job/PR views, local-time and status-announcement primitives, responsive
  navigation, and component tests.
- Playwright mobile/keyboard specifications and cross-boundary API/durability,
  security, concurrency, and performance test harnesses.

### Changed

- Compose now gates API and worker startup on a one-shot migration service, uses
  an explicit read-only Autopilotagent mount, and health-checks API and web.
- Deployment and operations documentation now distinguishes implemented runtime
  wiring from the remaining cancellation, reconciliation, outbox/PR,
  observability, and multi-replica limitations.

### Fixed

- Authentication no longer exposes or logs raw session tokens, and unsafe
  client-generated CSRF tokens are rejected.
- Health probe exceptions are contained; database failure reports `down` while
  other dependency failures report `degraded`.
- Activity pagination uses a stable tuple cursor, PR retry intent creation is
  transactional, timestamps report the displayed timezone, and diagnostic logs
  share the secret-redaction policy.
- Development retries now lock and atomically transition features back to
  `QUEUED`; worker startup composes full orphan reconciliation, and long-running
  Autopilot processes no longer lose ownership after an implicit timeout.
- Browser API fixtures no longer intercept Vite source-module requests, allowing
  the desktop and mobile Playwright journeys to run deterministically.

## 2026-07-18

### Added

- Docker/Compose deployment scaffolding with separate web (nginx), API (Hono), worker, and PostgreSQL service definitions.
- Multi-stage Dockerfiles with non-root runtime users and worker tool validation (git, jq, gh).
- Persistent volumes for PostgreSQL data and intended diagnostic-log storage;
  runtime log retention/bounding is not yet wired.
- Worker-only workspace mount isolation; web service never receives host workspace mounts.
- Environment-based secret configuration with `.env.example` template and no secrets in images.
- Hono liveness/readiness route contracts and injectable database, worker, autopilot, and GitHub health aggregation; production probes are not yet composed.
- Shared structured JSON logger primitive with correlation, project/feature/job context, and redaction support; application entrypoints are not yet wired to emit through it.
- Shared in-memory runtime metrics collector for queue depth, active jobs, heartbeat age, adapter errors, and polling lag; it is not yet exposed by an application entrypoint.
- Deployment documentation covering prerequisites, secrets, migrations, TLS, and startup.
- Operations documentation covering backup, recovery, cancellation, interruption handling, and safe upgrades.
- Deployment configuration test suite validating Compose, Dockerfiles, volumes, secrets, and observability.

## 2026-07-17

### Added

- Initial documentation structure.
