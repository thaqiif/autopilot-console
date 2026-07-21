# autopilot-console-phase-1 Progress Notes

## Current State
- Last verified complete in the task ledger: requirement 21.
- Working on: requirements 22–31 remain incomplete after the 2026-07-21
  acceptance-level re-audit.
- The new API, web, deployment, and release-test code is useful progress, but it
  does not close the remaining production wiring and end-to-end proof gaps.
- Quality gate status (2026-07-21):
  - lint: GREEN (258 files).
  - typecheck: GREEN (all 9 workspaces).
  - build: GREEN (all workspaces).
  - targeted web tests: GREEN (369 tests).
  - Playwright: GREEN (48 desktop/mobile Chromium tests), but the suite does
    not complete all required owner journeys and can pass while API proxy calls
    fail.
  - root test matrix: RED because PostgreSQL-backed suites reset the same
    public schema concurrently; API tests observe missing sessions and migration
    tables.
  - critical branch coverage gate: RED; multiple domain/process-control modules
    remain below 90 percent or are not found by the coverage run.
  - installed Autopilot CLI contract: 3 critical-path checks remain opt-in and
    skipped by the default suite.
  - requirement 21 API gates: GREEN (typecheck, 122 tests, lint).

## Files Modified (req 21)
- apps/api/src/app.integration.test.ts — added exact public-route, invalid and
  revoked session, same-origin mutation, login correlation, production worker
  capacity, and concurrent isolated-schema coverage.
- apps/api/src/app.ts — wired trusted-origin CSRF options and simplified health
  service construction.
- apps/api/src/middleware/authentication.ts — changed the public boundary from
  prefix matching to an exact method-and-path allowlist.
- apps/api/src/middleware/csrf.ts — rejects cross-origin browser mutations,
  including login, before CSRF exemptions are evaluated.
- apps/api/src/routes/auth.ts — preserves correlation IDs on login failures and
  reuses the shared session-cookie parser.
- apps/api/src/main.ts — reports worker heartbeat, capacity, active jobs, and
  available slots through redacted production readiness probes.
- packages/database/src/{client.ts,index.ts,schema/*,testing/test-helpers.ts} —
  added unique-schema test clients and made migration detection schema-aware.

## 2026-07-21 Acceptance Re-audit

- Requirements 21–31 and every associated TDD stage remain `passes: false`.
- Requirement 21 lacks a complete production-route protection matrix, origin
  validation, complete dependency health, and isolated database fixtures.
- Requirement 22 lacks stable cancellation/CRUD idempotency, running-process
  cancellation routing, task invalidate/replace APIs, and target-scale valid
  queue latency proof.
- Requirement 23 lacks complete attention/detail projections and pagination;
  SSE gap/reconciliation proof is incomplete.
- Requirements 24–29 still have API/UI contract gaps, incomplete view-state and
  SSE handling, no validate-before-save project flow, incorrect task invalidation
  and confirmation context, incomplete job/PR integration, and presence/width
  checks in place of complete mobile and keyboard journeys.
- Requirement 30 still has unwired runtime logging/metrics, diagnostic retention,
  agent-CLI validation, worker capacity health, production PR lifecycle work,
  and running cancellation.
- Requirement 31 does not run the full development-to-merge owner journey,
  required restart/concurrency/security cases, or a green 90-percent critical
  coverage and aggregate release matrix.

## 2026-07-19 Codebase Audit

- Requirements 21–31 and their TDD stages were reset to `passes: false` after
  review found that their acceptance and quality gates are not met by the
  current repository.
- The root test script now runs package-owned suites before repository tests,
  preventing Bun from discovering debug and Playwright artifacts as unit tests.
- API and worker Docker commands now use long-running `main.ts` entrypoints, and
  Compose orders them behind an advisory-locked migration service.
- Deployment and operations guides distinguish implemented runtime wiring from
  remaining production lifecycle limitations.

## Files Modified (req 25)
- apps/web/src/features/overview/overview-page.tsx (new) — Overview page: attention-first ordering, metrics, recent activity
- apps/web/src/features/overview/overview-page.test.tsx (new) — 40 tests: ordering, metrics, attention cards, filters, activity, settings, view states, SSE
- apps/web/src/features/attention/attention-page.tsx (new) — Full Attention page with category filters
- apps/web/src/features/attention/attention-page.test.tsx (new) — 7 tests: rendering, categories, action links, view states
- apps/web/src/features/attention/attention-card.tsx (new) — AttentionCard component with project/release/feature/reason/state/action
- apps/web/src/features/activity/activity-page.tsx (new) — Activity page with cursor pagination
- apps/web/src/features/settings/settings-page.tsx (new) — Settings & Status page with redacted health display
- apps/web/src/components/metrics/summary-card.tsx (new) — SummaryCard metric display component
- apps/web/src/components/feedback/view-state.tsx (new) — ViewState: loading, empty, error, stale, unauthorized
- apps/web/src/app/router.tsx (new) — Router wiring all new pages into AppShell

## Files Modified (req 20)
- apps/worker/src/github/pr-handoff-worker.ts (new) — PR handoff worker: push, exactly-once PR identity, idempotent intents
- apps/worker/src/github/pr-reconciliation-worker.ts (new) — durable CI/review polling, monotonic observations, merge/closed detection
- apps/worker/src/github/github-backoff.ts (new) — bounded backoff policy
- apps/worker/src/github/pr-handoff-worker.integration.test.ts (new) — 10 handoff contract tests
- apps/worker/src/github/pr-reconciliation-worker.integration.test.ts (new) — 13 reconciliation contract tests

## Requirement 25 history

### Requirement 1–13
- Completed: 2026-07-18 (prior sessions)

### Requirement 14–18
- Completed: 2026-07-18 (prior sessions)

### Requirement 19: Cancellation, process-tree escalation, orphan handling, retry
- Started: 2026-07-18
- Completed: 2026-07-18
- Files Changed:
  - apps/worker/src/process/cancellation-controller.ts — CancellationController interface + createCancellationController factory
  - apps/worker/src/process/cancellation-controller.integration.test.ts — 13 contract tests (QUEUED/RUNNING cancel, escalation, PID reuse, idempotency)
  - apps/worker/src/process/retry-service.ts — RetryService interface + createRetryService factory
  - apps/worker/src/process/retry-service.integration.test.ts — 9 contract tests (FAILED/INTERRUPTED/CANCELLED retry, liveness, idempotency, branch reuse)
  - apps/worker/src/process/process-tree.ts — OS ProcessTreeInspector impl (procfs, SIGUSR1→SIGTERM→SIGKILL escalation)
  - apps/worker/src/process/orphan-reconciler.ts — OrphanReconciler for worker restart cleanup (INTERRUPTED, no auto-relaunch)
- Learnings:
  - Cancellation escalation uses SIGUSR1 → grace → SIGTERM descendants+parent → grace → SIGKILL.
  - PID reuse detection via /proc/{pid}/stat starttime comparison (±20ms tolerance).
  - Retry only for FAILED/INTERRUPTED/CANCELLED states, creates immutable linked attempt with predecessorAttemptId.
  - Retry reuses same feature branch and current task progress; liveness check prevents retry while process active.
  - All cancellation/retry mutations use applyFeatureTransition for deterministic state transitions.

## Session Log
- [2026-07-18] Completed requirement 19 (prior batch)
- [2026-07-18] Completed requirement 20: committed uncommitted github worker implementation (23 tests green; typecheck + lint pass)
- [2026-07-18] Recorded component implementation for requirement 25: Overview,
  Attention, Activity, and Settings pages (47 component tests green at the time)
- [2026-07-19] Integration review found response-contract and runtime wiring
  gaps; requirements 21–31 were returned to incomplete status
- [2026-07-21] Completed requirement 21 after a fresh RED/GREEN/refactor cycle;
  API typecheck, all 122 API tests, and API lint are green.

## Requirement 31 history (continued)

### Requirement 31 refactor phase: 2026-07-19
- Created comprehensive feature-service.integration.test.ts (28 tests) covering all
  branches: createFeature validation/success/transactional-failures, getFeature,
  updateFeature validation/success/collision/archived/transactional-failures
- Verified quality matrix for non-PG packages:
  - typecheck: 9/9 green
  - lint: 257 files clean
  - Non-PG tests: 157 pass, 3 skip (opt-in CLI), 0 fail
  - Web tests: 375 pass, 0 fail
  - Repo tests: 118 pass, 0 fail
  - Retry contract tests: 11 pass, 0 fail
  - Total verified: ~661 tests passing
- PostgreSQL-dependent tests (domain, database, api, worker integration) cannot
  run in this sandbox environment; 6 critical modules still need coverage
  improvement when PG is available
- Commit: 5c0822a test: add comprehensive feature-service integration tests

## Progress

### Requirement 21: Hono API application boundary
- Started: 2026-07-21
- Completed: 2026-07-21
- TDD: RED confirmed for missing production health export and isolated database
  helper; GREEN and scoped simplifier refactor completed.
- Verification: API typecheck green; 122 tests green; API lint green.
- Commit: e6666bd feat(api): harden authenticated boundary and isolated fixtures
  (req 21)
- Files Changed: API app/auth/health middleware and isolated PostgreSQL test
  infrastructure listed above.

### Requirement 25: Build global Overview, full Attention, Activity, and Settings/status pages
- Component implementation recorded: 2026-07-18
- Full acceptance status: incomplete after 2026-07-19 integration review
- Commits:
  - b47f0d9 feat(web): implement Overview, Attention, Activity, Settings pages (req 25 GREEN)
  - c02f75a feat(web): wire Overview, Attention, Activity, Settings into router (req 25)
- Tests: 47 pass, 0 fail
- Files Changed: 13 files, 926 insertions

### Requirement 31: Phase 1 quality gates (implement phase)
- Started: 2026-07-19
- Implement phase completed: 2026-07-19
- Files Changed:
  - scripts/check-critical-coverage.ts (new) — Critical module coverage checker using Bun text output
  - package.json (modified) — Added test:integration and coverage:critical scripts
  - apps/api/src/routes/reads.integration.test.ts (modified) — Fixed non-null assertion lint errors
- Commits:
  - 53580e7 feat: wire critical coverage gates and quality infrastructure (req 31 implement)
- Quality gates:
  - lint: CLEAN (256 files)
  - typecheck: GREEN (all 9 packages)
  - Critical coverage: 13/19 modules ≥90% branch
  - 6 modules need improvement: domain/feature-service (53.95%), domain/release-service (82.08%), domain/project-service (85.36%), process-control/cancellation-controller (needs PostgreSQL), process-control/retry-service (78.98%), process-control/process-tree (needs PostgreSQL)
