# autopilot-console-phase-1 Progress Notes

## Current State
- Last completed: requirement 25
- Working on: none (batch 1 complete)
- Blockers: none

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

## Progress

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
- [2026-07-18] Completed requirement 25: Overview, Attention, Activity, Settings pages (47 tests green; typecheck + lint pass)

## Progress

### Requirement 25: Build global Overview, full Attention, Activity, and Settings/status pages
- Completed: 2026-07-18
- Commits:
  - b47f0d9 feat(web): implement Overview, Attention, Activity, Settings pages (req 25 GREEN)
  - c02f75a feat(web): wire Overview, Attention, Activity, Settings into router (req 25)
- Tests: 47 pass, 0 fail
- Files Changed: 13 files, 926 insertions
