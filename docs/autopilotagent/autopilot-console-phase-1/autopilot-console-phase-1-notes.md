# autopilot-console-phase-1 Progress Notes

## Current State
- Last completed: requirement 5
- Working on: none (batch 1 complete)
- Blockers: none

## Files Modified
- packages/domain/src/feature/feature-state.ts
- packages/domain/src/feature/feature-transition.ts
- packages/domain/src/feature/feature-state-machine.ts
- packages/domain/src/feature/feature-state-machine.test.ts
- packages/domain/src/index.ts

## Progress

### Requirement 1: Bootstrap Bun workspace and quality gates
- Started: 2026-07-18
- Completed: 2026-07-18
- Commits:
  - bccd544 test(architecture): add failing workspace bootstrap architecture suite
  - 20a85ec feat(workspace): bootstrap Bun monorepo with quality gates
  - 144f960 chore(workspace): ignore core dumps from local tooling

### Requirement 2: Shared runtime config, contracts, redaction
- Started: 2026-07-18
- Completed: 2026-07-18
- Commits:
  - 604c03c test(shared): add failing runtime-config, redaction, and contract suites
  - 6301634 feat(shared): implement runtime config, contracts, redaction, and errors
  - (refactor) drop .ts import extensions for tsc, biome format
- Files Changed:
  - packages/shared full public surface for config/contracts/ids/time/errors/idempotency/correlation/redaction

### Requirement 3: PostgreSQL core data model
- Started: 2026-07-18
- Completed: 2026-07-18
- Commits:
  - 7f3bf93 test(database): add failing core schema integration suite
  - 483d38d feat(database): implement core PostgreSQL schema and repositories
  - 95e0d37 refactor(database): rename core migration module off core.* ignore
- Files Changed:
  - migration 0001_core_entities.sql (workspace, admin, sessions, projects, releases, features, task_approvals, pull_requests)
  - hierarchy triggers, immutable approval/PR identity triggers, partial unique indexes for active projects
  - postgres client (prepare:false, max:1 for tests), fixtures, repositories
- Learnings:
  - Agent container cannot reach Docker published host ports; join docker network and use service hostname.
  - `core.*` gitignore for core dumps also matches `schema/core.ts` — use core-migration.ts.
  - bun/postgres `expect().rejects` can hang; use try/catch mustReject helper.
  - Prefer TRUNCATE isolation over DROP SCHEMA per test when pool/DDL thrash is an issue.

### Requirement 4: Workflow persistence (attempts, events, outbox)
- Started: 2026-07-18
- Completed: 2026-07-18
- Commits:
  - 0de970f test(database): add failing workflow schema integration suite
  - 8d27931 feat(database): implement workflow PostgreSQL schema and repositories
  - 04682c2 refactor(database): centralize JSON binding helper for workflow repos

### Requirement 5: Feature lifecycle state machine
- Started: 2026-07-18
- Completed: 2026-07-18
- Duration: ~session
- Commits:
  - 557e18f test(domain): add failing feature lifecycle state-machine matrix suite
  - 92841af feat(domain): implement feature lifecycle state machine
  - 3cb898d refactor(domain): cover isFeatureState and keep transition table declarative
- Files Changed:
  - packages/domain/src/feature/feature-state.ts (closed F-5 state set + terminal helper)
  - packages/domain/src/feature/feature-transition.ts (command/result types, owners)
  - packages/domain/src/feature/feature-state-machine.ts (declarative table, applyFeatureTransition, listAllowedTransitions)
  - packages/domain/src/feature/feature-state-machine.test.ts (exhaustive matrix)
  - packages/domain/src/index.ts (public exports)
- Learnings:
  - Domain package has no `@autopilot-console/shared` dependency; keep pure UTC ISO via Date#toISOString in domain.
  - BLOCKED is open from every nonterminal via `guard` only; DEVELOPMENT_MERGED is hard-terminal (no BLOCKED either).
  - Idempotency is modeled as command carrying priorAppliedOperationId/result so pure service stays side-effect free.

## Session Log
- [2026-07-18] Started task file
- [2026-07-18] Completed requirement 1 (Red/Green/Refactor)
- [2026-07-18] Completed requirement 2 (Red/Green/Refactor)
- [2026-07-18] Completed requirement 3 (Red/Green/Refactor)
- [2026-07-18] Completed requirement 4 (Red/Green/Refactor)
- [2026-07-18] Completed requirement 5 (Red/Green/Refactor)
- [2026-07-18] Batch 1 complete — stop after 1 requirement
