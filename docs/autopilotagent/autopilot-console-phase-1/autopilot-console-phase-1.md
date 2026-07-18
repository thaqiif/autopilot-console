# Autopilot Console Phase 1 — Product Requirements Document

- **Status:** Draft for human review and approval
- **Date:** 2026-07-17
- **Source vision:** `docs/autopilot-console-vision.md`
- **Phase boundary:** Multi-project portfolio control through feature PR merge detection

## 1. Introduction and Overview

Autopilot Console is a single-user, self-hosted, mobile-friendly control plane for autonomous software development across multiple projects. It sits above the existing `autopilotagent` CLI from autopilot-multi; it does not reimplement the autonomous TDD engine.

Today, autonomous development is initiated and observed from individual terminal sessions. This makes portfolio status difficult to see, requires the owner to inspect projects one at a time, and creates a risk that long-running work is coupled to a browser or terminal connection. Phase 1 delivers an end-to-end vertical slice in which the owner can register existing project workspaces, organize releases and features, attach task JSON generated through the existing terminal workflow, approve and queue development, monitor durable server-side execution, and follow the resulting GitHub pull request until merge.

The browser is only a control panel. Development jobs run in a separate server-side worker, and all meaningful workflow state is persisted in PostgreSQL. Closing the browser or changing devices does not stop queued or running work.

### 1.1 Primary persona

The sole Phase 1 persona is the **Product Manager / Owner / Administrator**. This person owns every configured project and is responsible for:

- registering and configuring trusted project workspaces;
- organizing releases and features;
- generating PRDs and task JSON outside Console using the current terminal commands;
- reviewing the parsed task summary and approving development;
- monitoring progress and responding to failures;
- reviewing and merging feature PRs in GitHub.

Phase 1 has no secondary personas, teams, invitations, roles, or per-project permissions.

### 1.2 Phase 1 scope statement

Phase 1 begins with an existing server-side Git repository and an existing autopilot task JSON file. It ends when Console detects that the generated feature PR has been merged into the project's configured development branch.

After merge, the feature enters **Development Merged**, which is the Phase 1 terminal state. This state does not mean the feature has passed DEV, UAT, or production release gates. Release views therefore report **development progress** rather than production completion.

### 1.3 Product principles

1. **Durability over connection:** HTTP requests and browser sessions never own long-running work.
2. **One portfolio view:** the default route summarizes all projects rather than opening one project.
3. **Attention over noise:** the owner can identify every required decision or intervention without inspecting each project.
4. **Deterministic operations stay deterministic:** queueing, process control, state transitions, Git actions, PR creation, and status polling do not use an LLM.
5. **Agents remain behind an adapter:** Console invokes autopilot-multi rather than copying or depending directly on its internal implementation.
6. **Human gates are explicit and auditable:** development cannot start until the imported tasks are approved; feature PRs are never merged by Console.
7. **Project isolation is mandatory:** paths, processes, queue constraints, and Git operations prevent work in one project from affecting another.

## 2. Goals

### 2.1 Product goals

1. Provide a global dashboard that shows up to 10 configured projects, their active work, and all attention items in one mobile-friendly view.
2. Let the owner model projects, releases, and features and see development progress for each release.
3. Validate and display an existing project-relative autopilot task JSON file without requiring raw JSON review.
4. Require one explicit **Approve & Queue Development** action before autonomous development begins.
5. Execute up to four development jobs concurrently across different projects while enforcing at most one active development job per project.
6. Persist job, process, progress, event, and audit state so browser closure or network loss has no effect on execution.
7. Show requirement-level TDD progress using autopilot-multi's structured task JSON, notes, analytics, and Git history as the primary evidence.
8. Automatically push a successful feature branch, create one GitHub PR, poll CI and review status, and detect the merge.
9. Surface task approvals, failed or interrupted jobs, PR failures, CI failures, requested changes, and review-ready PRs in **Needs Your Attention**.
10. Make all core owner actions usable at an iPhone-sized viewport and keyboard-accessible on desktop.

### 2.2 Measurable success criteria

- Creating or queueing work returns an HTTP response within 2 seconds under the target operating scale; the background process starts asynchronously.
- A queued or running job continues when the initiating browser closes and remains visible after a new login from another device.
- No two development attempts can run concurrently for the same project.
- Repeated queue requests and repeated PR-creation attempts do not create duplicate jobs or PRs.
- Every workflow transition records its prior state, next state, timestamp, cause, and actor.
- At least 95% of dashboard and feature-detail API reads complete within 1 second with 10 projects, 100 releases, 500 features, and four active jobs on the supported single-server deployment.
- The mobile owner journeys in Section 3 work at a 375 CSS-pixel viewport without horizontal page scrolling.
- The state-transition unit suite covers every allowed transition and rejects every disallowed transition.
- Integration tests prove durable queue claiming, per-project mutual exclusion, cancellation, interrupted-job handling, and PR idempotency.

## 3. User Stories and Journeys

### 3.1 User stories

- As the owner, I want the home screen to summarize all projects so I can understand portfolio status in seconds.
- As the owner, I want a single attention queue so I do not have to inspect projects to find blocked agent work or pending decisions.
- As the owner, I want to register an existing repository path and validate its integrations before scheduling work.
- As the owner, I want to group features into releases so I can plan by release rather than by sprint.
- As the owner, I want to attach a previously generated task JSON file and review its requirements in a readable format.
- As the owner, I want an explicit approval action so autonomous development never begins accidentally.
- As the owner, I want work to remain queued or running after I close my phone browser.
- As the owner, I want to see which requirement and TDD phase is active, what completed, and why work stopped.
- As the owner, I want to cancel a job gracefully when possible and force termination when it will not stop.
- As the owner, I want to retry a failed, interrupted, or cancelled run deliberately without starting a duplicate process.
- As the owner, I want Console to create the feature PR automatically after successful development but never merge it for me.
- As the owner, I want CI failures and requested changes surfaced with direct GitHub links while I fix them outside Console.
- As the owner, I want Console to notice when external fixes make CI pass and when I merge the PR.
- As the owner, I want release progress to distinguish code merged into development from delivery to production.

### 3.2 Journey A — Register a project

1. The owner opens **Projects** and chooses **Add Project**.
2. The owner enters the project name, GitHub owner/repository, absolute server workspace path, and development branch.
3. Console resolves and validates the path against configured workspace roots, confirms it is a Git repository, verifies its remote identity, confirms the development branch exists, checks the globally installed `autopilotagent` executable, and runs `gh` authentication/repository-access checks.
4. Console reports each validation result without exposing credentials.
5. The owner saves only after all required checks pass.
6. A structured audit event records project creation and validation results.

### 3.3 Journey B — Plan a release and feature

1. The owner opens a project and creates a release with a project-unique name or version and optional description.
2. The owner adds a feature with a title, slug, and optional summary.
3. The new feature enters **Planned**.
4. The release shows zero of its features as development merged.

### 3.4 Journey C — Attach and approve tasks

1. After using terminal `/prd` and `/tasks`, the owner enters a task JSON path relative to the registered project root.
2. Console rejects absolute paths, traversal, symlink escapes, non-JSON files, schema violations, duplicate requirement IDs, missing dependencies, dependency cycles, and task files that cannot represent a fresh or resumable run.
3. Console parses and displays the feature name, description, goals, non-goals, requirements, dependencies, acceptance criteria, TDD phases, pass/stuck/invalid status, and blocked reasons.
4. Console stores an immutable approval snapshot and checksum while leaving the source file in the project for `autopilotagent` to update.
5. The owner selects **Approve & Queue Development**.
6. Console records the human approval and atomically queues one development attempt.

### 3.5 Journey D — Durable development

1. A worker claims the oldest eligible queued job when global capacity and the project's one-job limit permit.
2. The worker performs project and Git preflight checks and creates `feature/<feature-id>-<slug>` from the latest configured remote development branch. A retry reuses the feature's existing branch.
3. The worker invokes the globally available `autopilotagent` executable with the validated task path as an argument and the registered project root as its working directory. It does not invoke an interactive shell.
4. Console records the process identity, heartbeat, output, task-file changes, notes, analytics, and relevant commits as structured progress and activity.
5. The owner can close the browser, return later, and reconstruct the same state from persisted data.
6. Console succeeds the run only when the process exits successfully and every requirement has `passes: true`. Stuck, invalid, or unresolved requirements prevent automatic PR creation.

### 3.6 Journey E — Cancel or retry

1. The owner requests cancellation from the job or feature view.
2. Console marks cancellation requested, sends the CLI's graceful stop signal, and waits for a configured grace period.
3. If the process tree remains alive, Console sends termination and then forced-kill signals after bounded timeouts.
4. Console records **Development Cancelled** and preserves branch state, task progress, logs, and audit history.
5. The owner may explicitly retry a failed, interrupted, or cancelled attempt after Console verifies no related process is alive.
6. The new attempt resumes from the existing feature branch and structured task state; it is a distinct immutable job attempt.

### 3.7 Journey F — PR, CI, review, and merge

1. On successful development, Console pushes the generated feature branch.
2. Console creates exactly one PR targeting the configured development branch and stores its immutable GitHub repository, number, URL, head SHA, and head/base branches.
3. Console polls GitHub durably through `gh` for checks, review decision, PR state, and merge state.
4. Pending checks show **CI Running**. Failed checks show **CI Failed** in **Needs Your Attention** with GitHub links. Console does not launch a repair agent.
5. If an external fix is pushed, polling reconciles the new head SHA and check suite without user refresh.
6. Passing required checks show **PR Review**. A requested-changes review shows **PR Changes Requested**. Both are attention items.
7. The owner reviews and merges in GitHub; Console provides links but no merge action.
8. Polling detects the merge, moves the feature to **Development Merged**, updates release development progress, and records a structured activity and audit event.

### 3.8 Journey G — Thirty-second portfolio review

1. The owner opens Console on a phone and lands on **Overview**.
2. **Needs Your Attention** appears before lower-priority metrics and activity.
3. Each card identifies the project, release where useful, feature, reason, age, and one primary action.
4. The owner can reach the relevant task summary, job failure, or GitHub PR in one tap.
5. Summary cards show active jobs, queued jobs, failed/interrupted work, PRs awaiting review, and development-merged release progress across all projects.

## 4. Requirements

### 4.1 Functional requirements

#### F-1. Single-administrator authentication

1. Console shall require authentication for every application and API route except health checks and the login flow.
2. Phase 1 shall support exactly one administrator account.
3. The administrator password shall be bootstrapped from secret deployment configuration, validated for minimum strength, hashed with a current password-hashing algorithm, and never stored or logged in plaintext.
4. Sessions shall use opaque, revocable tokens stored in PostgreSQL and delivered in `HttpOnly`, `SameSite=Strict` cookies with `Secure` enabled in production.
5. Login shall be rate-limited. State-changing browser requests shall be protected against CSRF.
6. Logout and session expiration shall revoke server-side session state.

#### F-2. Workspace and project registry

1. Phase 1 shall contain one implicit workspace with many projects.
2. A project shall contain:
   - immutable ID;
   - unique name and slug;
   - optional description;
   - GitHub owner and repository name;
   - canonical server workspace path;
   - configured development branch;
   - validation status and last validation timestamp;
   - active or archived status;
   - created and updated timestamps.
3. Console shall register only existing server-side repositories; it shall not clone repositories.
4. Project paths shall resolve inside an operator-configured allowlist of workspace roots. Real-path and symlink checks shall prevent escape from those roots.
5. A canonical workspace path shall be unique among active projects so the same checkout cannot be scheduled through two project records.
6. Saving a project shall require successful repository, remote, branch, `autopilotagent`, `gh auth`, and GitHub-access validation.
7. A project with queued or active jobs shall not be archived or have its path, repository identity, or development branch changed.
8. Phase 1 shall archive rather than destructively delete projects with history.

#### F-3. Releases

1. A project may contain multiple releases; each release belongs to exactly one project.
2. A release shall contain an ID, project-unique name/version, optional description, ordering value, status, and timestamps.
3. Release status shall be one of **Planned**, **In Development**, or **Development Merged** for Phase 1.
4. Release development progress shall be calculated as features in **Development Merged** divided by all non-archived release features.
5. The UI shall label the metric **development progress** and shall not call a Phase 1 release production-ready or released.
6. A release shall be archivable only when it has no queued or active feature job.

#### F-4. Features and task artifacts

1. Every feature shall belong to exactly one release and, through that release, one project.
2. A feature shall contain an ID, unique project-scoped slug, title, optional summary, lifecycle state, generated branch name, task path, task approval snapshot/checksum, current job attempt, GitHub PR reference, and timestamps.
3. The task path shall be relative to the project's canonical root and shall resolve within that root without following a symlink outside it.
4. Console shall validate task JSON against the supported autopilot-multi task schema and additional semantic rules before displaying or approving it.
5. Console shall render task data as structured UI. Raw JSON may be available as a secondary diagnostic view but shall not be required for approval.
6. The task approval snapshot shall preserve the exact approved requirements and checksum even though `autopilotagent` mutates the repository task file during execution.
7. Replacing a task file shall be allowed only before approval or after a failed/interrupted/cancelled attempt with an explicit invalidation of the prior approval. Every replacement and reapproval shall be audited.
8. A single **Approve & Queue Development** action shall approve the displayed checksum and create the first queued job atomically.

#### F-5. Feature lifecycle and state machine

The Phase 1 feature states are:

| State | Meaning | Needs attention |
|---|---|---:|
| `PLANNED` | Feature exists without an approved task artifact | No |
| `TASKS_REVIEW` | Valid task JSON is ready for owner review | Yes |
| `QUEUED` | Tasks are approved and a development attempt awaits capacity | No |
| `DEVELOPING` | A worker owns the active Autopilot attempt | No |
| `DEVELOPMENT_FAILED` | The process failed or ended without all requirements passing | Yes |
| `DEVELOPMENT_INTERRUPTED` | Worker/process ownership was lost and manual restart is required | Yes |
| `DEVELOPMENT_CANCELLED` | The owner cancelled the latest attempt | No |
| `DEVELOPMENT_COMPLETE` | All requirements passed; Git/PR automation is pending | No |
| `PR_CREATING` | Branch push and idempotent PR creation are running | No |
| `PR_CREATION_FAILED` | Push or PR creation failed | Yes |
| `CI_RUNNING` | The PR exists and required checks are pending | No |
| `CI_FAILED` | One or more checks failed | Yes |
| `PR_REVIEW` | Checks pass and human review/merge is required | Yes |
| `PR_CHANGES_REQUESTED` | GitHub review requests external changes | Yes |
| `DEVELOPMENT_MERGED` | GitHub reports the feature PR merged to the configured development branch | No |
| `BLOCKED` | An invariant or unrecoverable validation issue prevents progress | Yes |

Allowed transitions and their owners are:

| From | To | Trigger owner | Trigger |
|---|---|---|---|
| `PLANNED` | `TASKS_REVIEW` | Human + deterministic validation | Owner attaches a valid task file |
| `TASKS_REVIEW` | `PLANNED` | Human | Owner removes or replaces the task file |
| `TASKS_REVIEW` | `QUEUED` | Human | Owner approves the displayed checksum and queues development |
| `QUEUED` | `DEVELOPING` | Deterministic worker | Eligible worker atomically claims the job |
| `QUEUED` | `DEVELOPMENT_CANCELLED` | Human | Owner cancels before claim |
| `DEVELOPING` | `DEVELOPMENT_COMPLETE` | Agent result + deterministic verification | Process exits zero and all requirements pass |
| `DEVELOPING` | `DEVELOPMENT_FAILED` | Deterministic worker | Nonzero exit, stuck/invalid/unpassed tasks, or bounded execution failure |
| `DEVELOPING` | `DEVELOPMENT_INTERRUPTED` | Deterministic reconciliation | Worker ownership or process continuity is lost |
| `DEVELOPING` | `DEVELOPMENT_CANCELLED` | Human + deterministic process control | Requested cancellation completes |
| Failed/interrupted/cancelled | `QUEUED` | Human | Explicit retry passes all preflight and no process is alive |
| `DEVELOPMENT_COMPLETE` | `PR_CREATING` | Deterministic worker | Git and GitHub handoff starts |
| `PR_CREATING` | `CI_RUNNING` | Deterministic GitHub adapter | Existing or newly created PR is persisted |
| `PR_CREATING` | `PR_CREATION_FAILED` | Deterministic GitHub adapter | Push or PR creation fails after bounded retries |
| `PR_CREATION_FAILED` | `PR_CREATING` | Human | Explicit retry |
| `CI_RUNNING` | `CI_FAILED` | Deterministic poller | A current-head required check fails |
| `CI_RUNNING` | `PR_REVIEW` | Deterministic poller | All required checks pass or no checks are required |
| `CI_FAILED` | `CI_RUNNING` | Deterministic poller | A new head/check run is pending |
| `CI_FAILED` | `PR_REVIEW` | Deterministic poller | External fix results in passing checks |
| `PR_REVIEW` | `PR_CHANGES_REQUESTED` | Deterministic poller | GitHub review decision requests changes |
| `PR_CHANGES_REQUESTED` | `CI_RUNNING` or `PR_REVIEW` | Deterministic poller | External commits/reviews change PR status |
| Any PR state | `DEVELOPMENT_MERGED` | Deterministic poller | PR is merged to the configured development branch |
| Any nonterminal state | `BLOCKED` | Deterministic guard | A violated invariant cannot be safely repaired automatically |

Additional state rules:

1. All transitions shall go through one domain state-transition service; controllers and workers shall not update feature state directly.
2. Transitions shall be transactional, idempotent, and protected by an expected prior state or row version.
3. Disallowed transitions shall fail without changing state and shall create a security or diagnostic event where appropriate.
4. Agent reasoning may change repository artifacts and task status during `DEVELOPING`, but only deterministic Console code may change the Console feature state.
5. `DEVELOPMENT_MERGED` is terminal in Phase 1.

#### F-6. Development queue and job attempts

1. Jobs shall be durable PostgreSQL records, not in-memory promises or browser-owned processes.
2. The deployment shall default to a maximum of four concurrent development jobs, configurable downward or upward by the operator, and tested at four.
3. A database-enforced constraint or lock shall allow no more than one claimed/running development job per project.
4. The queue shall be FIFO by approval time among eligible jobs. Phase 1 shall not support priorities or manual reordering.
5. Queue claiming shall be transactional and safe with more than one worker process.
6. A job attempt shall include immutable feature/project/task/branch references, status, enqueue/start/end timestamps, worker identity, process identity, heartbeat, exit information, cancellation metadata, and structured result.
7. Job statuses shall include `QUEUED`, `RUNNING`, `CANCEL_REQUESTED`, `SUCCEEDED`, `FAILED`, `INTERRUPTED`, and `CANCELLED`.
8. Queue creation shall use an idempotency key and uniqueness constraints to prevent double taps or retried HTTP requests from creating duplicate active attempts.
9. A retry shall create a new attempt linked to the prior attempt. Prior attempts, logs, and results shall remain immutable.

#### F-7. Worker and process lifecycle

1. The API shall enqueue work and return without waiting for worker claim or process completion.
2. The worker shall spawn the executable directly with an argument array, a fixed working directory, a minimal controlled environment, and no interactive shell.
3. The current CLI command shall be conceptually equivalent to `autopilotagent <validated-relative-task-path>` from the project root. Product UI shall call the engine **Autopilot** while the adapter owns the binary name.
4. Phase 1 shall not allow administrator-defined or project-defined arbitrary shell command templates.
5. The worker shall capture stdout/stderr as bounded diagnostic logs, but structured task JSON, sibling notes, analytics files, and Git history shall be the primary progress sources.
6. The worker shall persist heartbeats and progress independently of connected browsers.
7. If a worker restarts or loses process ownership, Console shall attempt to terminate the known orphaned process tree, mark the attempt `INTERRUPTED`, and require an explicit manual retry. It shall not automatically resume or relaunch the attempt.
8. Manual retry shall remain disabled until Console verifies that no process associated with the previous attempt is alive.
9. Cancellation shall first send the graceful stop mechanism supported by autopilot-multi (currently `SIGUSR1` to its recorded wrapper PID), then bounded `SIGTERM`, then `SIGKILL` to the captured process tree if necessary.
10. Cancellation and cleanup shall never target PIDs without verifying their recorded process start identity, feature, and project ownership.

#### F-8. Development preflight and Git safety

1. Before the first attempt, Console shall fetch the configured remote and create the deterministic feature branch `feature/<feature-id>-<slug>` from the remote development branch.
2. The project workspace must be dedicated to Console-managed execution while a job is active.
3. Preflight shall reject unrelated uncommitted changes. The selected task artifact may be present or modified as part of the approved input; its approved checksum shall be preserved before branch operations.
4. Preflight shall verify that the current real path, Git repository identity, remote, base branch, task file, and generated branch all match the persisted project and feature.
5. A retry shall reuse the existing feature branch and task progress. It shall not create a second branch.
6. Console shall never force-push, rewrite published history, discard changes, reset the workspace destructively, or delete a branch in Phase 1.
7. A Git or path safety failure shall block execution and surface an actionable, redacted error.

#### F-9. Structured progress and activity

1. Console shall parse the supported task JSON fields, including requirement IDs, descriptions, dependencies, acceptance criteria, TDD phase pass flags, overall pass state, stuck state, invalid-test state, and blocked reason.
2. Console shall snapshot progress whenever the task file changes and periodically while the job is active.
3. Console shall ingest meaningful notes/analytics summaries and relevant commits without treating arbitrary terminal text as trusted workflow commands.
4. Structured activity types shall include project configured, release/feature created, tasks attached/approved, job queued/started/progressed/cancelled/failed/interrupted/completed, requirement/TDD phase completed, commit observed, branch pushed, PR created, CI changed, review changed, and PR merged.
5. Each activity record shall include project and feature references where applicable, type, timestamp, summary, structured metadata, and source.
6. The global and project activity feeds shall order records newest first and paginate them.
7. Live views may use server-sent events, but every view shall reload completely from REST/API state after disconnect; SSE shall never be the source of truth.

#### F-10. Failure handling

1. Phase 1 shall distinguish validation, queue, process, task-result, Git, GitHub, CI, cancellation, and interruption failures.
2. Error records shown to the owner shall include a safe summary, occurrence time, affected operation, latest attempt, and recommended next action.
3. Development, interruption, and PR-creation failures shall require an explicit manual retry.
4. CI failures shall remain under **Needs Your Attention**, link to the PR/checks in GitHub, and continue scheduled polling.
5. Phase 1 shall not start automatic or manual agent repair jobs from CI failures.
6. Transient GitHub polling errors shall use bounded exponential backoff and shall not regress a feature state based on missing data.
7. Repeated polling failure shall create an attention item while preserving the last known GitHub state.

#### F-11. GitHub PR workflow

1. GitHub is the only Phase 1 source-control provider.
2. Console shall use the server's pre-authenticated `gh` CLI session behind a typed GitHub adapter.
3. Project validation shall confirm `gh auth status`, repository read access, and the ability to identify the configured remote. Push permission shall be checked without mutating the remote where feasible and otherwise verified at push time.
4. After successful Autopilot completion, Console shall push the feature branch automatically and create a PR targeting the configured development branch.
5. PR creation shall be idempotent: before creating, Console shall check the persisted PR reference and query for an existing open or merged PR with the same repository and head branch.
6. Console shall store PR identity separately from mutable status observations.
7. A durable scheduled job shall poll open Phase 1 PRs at least once per minute by default, with operator-configurable interval and backoff.
8. Polling shall reconcile head SHA, checks, review decision, open/closed/merged state, merge commit, and timestamps.
9. Checks shall be evaluated only for the current PR head SHA. If no checks are required or reported after GitHub declares the head mergeable, the PR may move to **PR Review**.
10. Console shall never approve or merge a feature PR in Phase 1.
11. A PR closed without merge shall enter `BLOCKED` with an attention item and retain its history.

#### F-12. Global dashboard and attention queue

1. The authenticated default route shall be a global **Overview**, never a single-project dashboard.
2. **Needs Your Attention** shall be the first primary content section.
3. Attention items shall be derived from persisted workflow state rather than manually maintained flags.
4. Attention categories shall include task review, development failed, development interrupted, PR creation failed, CI failed, PR review, PR changes requested, blocked workflow, and stale GitHub synchronization.
5. Each attention card shall show project, feature, reason, age, current state, and one primary action.
6. Summary metrics shall show project count, active development jobs, queued jobs, attention count, failed/interrupted jobs, PRs awaiting review, and development-merged features/releases.
7. The global activity feed shall show structured cross-project events, not raw log lines.
8. Phase 1 shall provide in-app indicators only; email, SMS, and push notifications are out of scope.

#### F-13. Audit trail

1. Every human and automated mutation shall produce an append-only audit event in the same transaction as the mutation where practical.
2. Audit actors shall distinguish administrator, API system, worker, Autopilot process, GitHub poller, and reconciliation process.
3. Audit metadata shall include actor, action, target type/ID, prior and next values where safe, timestamp, correlation/job ID, and result.
4. Secrets, session tokens, authentication headers, and raw credential-bearing command output shall never enter audit metadata.
5. Audit history shall remain available after project, release, or feature archival.

### 4.2 UI requirements

#### U-1. Navigation and information architecture

1. Desktop navigation shall include **Overview**, **Attention**, **Releases**, **Projects**, **Activity**, and **Settings**.
2. Mobile bottom navigation shall contain at most four primary items: **Home**, **Attention**, **Releases**, and **Projects**. Activity and settings shall remain accessible through secondary navigation.
3. Project, release, feature, job, and PR pages shall provide consistent breadcrumbs or compact mobile back navigation.

#### U-2. Core screens

Phase 1 shall provide:

- login;
- global overview;
- full attention list with filters;
- global activity feed;
- projects list, create/edit/archive, and integration validation;
- project overview;
- releases list and release detail;
- feature create/detail;
- task-path attachment and parsed task review;
- approval confirmation;
- queue/job progress and attempt history;
- cancellation and retry confirmation;
- failure detail with safe diagnostics;
- PR/CI/review status with GitHub deep links;
- administrator and runtime settings/status.

#### U-3. Development progress

1. Feature detail shall show total, passed, active, stuck, invalid, and remaining requirement counts.
2. Each requirement shall show dependency state, acceptance criteria, TDD Red/Green/Refactor status, overall state, and blocked reason.
3. The active attempt shall show queued/start/elapsed timestamps, worker state, last heartbeat, active requirement where determinable, recent structured activity, and bounded diagnostic logs.
4. UI labels shall distinguish a Console job, an Autopilot process, a requirement, and a GitHub check.
5. Stale progress or disconnected live updates shall show the last update time and use automatic REST reconciliation.

#### U-4. Mobile and accessibility

1. All primary owner journeys shall work at 375×667 CSS pixels without horizontal page scrolling.
2. Tap targets shall be at least 44×44 CSS pixels where practical.
3. Important actions shall not depend on hover, right-click, drag-and-drop, or desktop-only dialogs.
4. Tables shall transform into readable cards or horizontally contained detail components on narrow screens.
5. Logs may use a desktop-optimized view, but mobile shall still show failure summaries and downloadable/copyable bounded excerpts.
6. The UI shall target WCAG 2.2 AA for color contrast, focus visibility, keyboard operation, form labeling, and status announcements.
7. Destructive or process-affecting actions shall require clear confirmation and show the exact project and feature.

#### U-5. UI states and feedback

1. Every data view shall define loading, empty, error, stale, and unauthorized states.
2. Mutating actions shall disable duplicate submission while pending and use backend idempotency as the final protection.
3. Status shall never be communicated by color alone.
4. Dates shall display in the browser's local timezone while retaining UTC timestamps in the API and database.

### 4.3 Integration requirements

#### I-1. AutopilotRunner boundary

Console shall define an `AutopilotRunner` interface with responsibilities to:

- validate runtime availability and task compatibility;
- start a task-file run in a fixed project root;
- identify and signal its process safely;
- inspect liveness and exit status;
- parse structured task progress and results;
- read relevant notes and analytics summaries;
- observe relevant Git commits;
- cancel a run gracefully and forcibly when required;
- return a normalized, redacted result.

The initial implementation shall invoke the current global `autopilotagent` CLI. It shall use the project's existing `autopilotagent.json` and shall not replace or duplicate that configuration.

The adapter shall be contract-tested against the checked-in/current autopilot-multi CLI behavior, including its task schema, mutable `passes`/`stuck`/`invalidTest` fields, notes location, per-feature PID file, exit behavior, and graceful `SIGUSR1` stop mechanism.

#### I-2. Task schema compatibility

1. Console shall version its supported autopilot task schema compatibility.
2. Import shall preserve unknown fields while reading known fields, unless an incompatible schema version requires rejection.
3. Console shall never rewrite task JSON merely to display it.
4. Reads shall tolerate atomic file replacement and shall never persist a partially written JSON snapshot as valid progress.
5. A malformed task file during a run shall retain the last valid snapshot, show a diagnostic event, and fail only after bounded retry or process completion proves it unrecoverable.

#### I-3. GitHubGateway boundary

Console shall define a typed `GitHubGateway` around `gh` for:

- authentication and repository validation;
- existing-PR lookup;
- PR creation;
- PR/check/review/merge status reads;
- normalized errors and redaction.

No application domain code shall parse ad hoc human-formatted `gh` output; adapter commands shall request JSON fields and validate their shape.

#### I-4. API-to-worker boundary

1. The API and worker shall communicate through PostgreSQL job and event records, not in-process calls.
2. API or web restarts shall not change queue ownership or stop jobs.
3. Worker heartbeats and leases shall identify loss of ownership, but expired running attempts shall become interrupted rather than automatically requeued.
4. The web application shall consume documented APIs and shall not access project workspaces directly.

### 4.4 Testing requirements

All implementation shall follow Red → Green → Refactor. A test that passes before its corresponding implementation does not satisfy the requirement.

#### T-1. Unit tests

- Exhaustively test every lifecycle transition in F-5, including idempotent repeats and forbidden transitions.
- Test attention-item derivation for every attention and non-attention state.
- Test release development-progress calculations, including empty and archived features.
- Test task schema and semantic validation, dependency cycles, duplicate IDs, path normalization, traversal, and symlink escape.
- Test branch-name sanitization and uniqueness.
- Test normalized Autopilot and GitHub result mapping.
- Test redaction of secrets and unsafe output.

#### T-2. Database and queue integration tests

- Use isolated database state per test or rollback transactions to prevent pollution.
- Prove atomic approval-and-enqueue behavior.
- Prove duplicate idempotency keys do not create duplicate jobs.
- Race multiple workers and prove a job is claimed once.
- Prove the global concurrency limit and one-active-job-per-project rule.
- Prove expired worker ownership produces `INTERRUPTED` without automatic relaunch.
- Prove state and audit events commit consistently.

#### T-3. Process integration tests

- Use a controllable fake executable to test spawn arguments, working directory, environment, streaming output, heartbeat, success, failure, hangs, cancellation escalation, and process-tree cleanup.
- Test browser/API disconnect while the fake run continues.
- Test malformed and concurrently updated task files.
- Test manual retry after failure/interruption and refusal while a previous process remains alive.
- Run a separate opt-in contract suite against the actual installed `autopilotagent` CLI in dry-run or fixture repositories.

#### T-4. Git and GitHub integration tests

- Use temporary repositories to test base fetch, branch creation, dirty-worktree rejection, retry branch reuse, and safe refusal of repository mismatch.
- Mock the `gh` boundary for PR lookup/create, changing head SHA, pending/passing/failing checks, requested changes, closed-without-merge, and merge detection.
- Prove PR creation remains single under concurrent/retried requests.
- Provide an opt-in test against a dedicated GitHub fixture repository; it shall never run against a production repository by default.

#### T-5. API, security, and end-to-end tests

- Test authentication, session revocation/expiration, login rate limiting, CSRF protection, and authorization on every mutation route.
- Test request validation and idempotency on approval, cancellation, retry, and PR operations.
- Test the complete owner journey from project registration through development-merge reconciliation with fake external adapters.
- Test core journeys at desktop and 375-pixel mobile viewports.
- Include automated accessibility checks plus keyboard-only assertions for primary workflows.
- Fix any flaky test immediately; timing tests shall use fake clocks or bounded event-based synchronization rather than arbitrary sleeps.

#### T-6. Quality gates

- Before any implementation commit: unit/integration tests, typecheck, and lint shall pass.
- Coverage thresholds shall be configured for critical domain, queue, path-security, process-control, and adapter code; these modules shall target at least 90% branch coverage.
- No failing or skipped critical-path test may be accepted to meet the threshold.

## 5. Non-Goals (Out of Scope)

Phase 1 shall not include:

1. Reimplementation or forking of the autopilot-multi TDD engine.
2. Web-based PRD discovery, clarification, editing, generation, or approval.
3. Web-based task generation or task JSON editing; tasks are generated through the existing terminal workflow.
4. Automatic or Console-launched agent repair of failed development, CI, review, deployment, or tests.
5. DEV deployment monitoring, automated DEV tests, or DEV manual approval.
6. UAT promotion, deployment, testing, or approval.
7. GitHub Release creation or production deployment.
8. Claiming that **Development Merged** means a feature or release is production complete.
9. Automatic PR approval or merge.
10. Repository cloning, deletion, arbitrary checkout management, or multiple worktrees per project.
11. More than one concurrent development job within a project.
12. Multi-user access, invitations, teams, RBAC, SSO, or tenant isolation.
13. GitLab, Bitbucket, or other source-control providers.
14. GitHub webhooks; Phase 1 uses durable scheduled polling.
15. Email, SMS, chat, or web-push notifications.
16. Sprint, backlog, story-point, or capacity planning.
17. User-configurable arbitrary shell command templates or duplicate Console-managed test/lint/typecheck commands after Autopilot completion.
18. Automatic resumption after worker/process interruption.
19. Distributed infrastructure beyond clear API/worker boundaries on one self-hosted server.
20. Native iOS/Android applications or offline mutation support.

## 6. Technical Considerations

### 6.1 Prescribed architecture

Phase 1 shall use a Bun workspace/monorepo with these logical boundaries:

```text
apps/
  web/       React + Vite responsive web application
  api/       Hono HTTP API and server-sent event endpoints
  worker/    durable development and reconciliation workers
packages/
  database/  PostgreSQL schema, migrations, repositories, queue primitives
  domain/    state machine, policies, value objects, attention derivation
  shared/    API contracts, validation schemas, shared types
  autopilot/ AutopilotRunner interface and CLI adapter
  github/    GitHubGateway interface and gh adapter
  git/       constrained Git operations and safety checks
```

The exact package names may change during implementation planning, but the web/API/worker separation and adapter boundaries are required.

### 6.2 Persistence and queue

- PostgreSQL is the source of truth for domain, queue, session, activity, audit, and normalized progress data.
- Queue claiming should use transactional PostgreSQL primitives such as row locking with skip-locked semantics and uniqueness constraints; Redis is not required for Phase 1.
- Large or high-frequency raw process logs may be stored in bounded append-only files or chunk storage referenced by PostgreSQL. Structured summaries and audit events remain in PostgreSQL.
- Diagnostic output shall have a configurable per-attempt size cap with an explicit truncation marker; truncation must not remove structured task progress or audit history.
- All stored timestamps use UTC.

### 6.3 Deployment

- Provide Dockerfiles and a Docker Compose deployment for web/API, worker, and PostgreSQL services.
- The worker runtime must contain the globally available `autopilotagent`, its selected agent CLI, `git`, `jq`, and `gh` binaries and their required authentication/configuration.
- Project directories must be mounted explicitly into the worker under operator-allowlisted roots. API/web containers shall not require write access to project source.
- PostgreSQL data, diagnostic logs, and application secrets shall use persistent volumes or secret mounts.
- Production deployment assumes TLS termination by a trusted reverse proxy.
- Health endpoints shall distinguish API liveness, database readiness, worker heartbeat, Autopilot availability, and GitHub authentication without exposing sensitive details.

### 6.4 Core data model

The minimum persistent entities are:

```text
Workspace (single implicit row)
└── Project
    └── Release
        └── Feature
            ├── TaskArtifactApproval
            ├── DevelopmentJobAttempt
            │   ├── ProgressSnapshot
            │   └── DiagnosticLogChunk
            └── PullRequest

ActivityEvent
AuditEvent
AttentionItem (derived or materialized projection)
AdminAccount
Session
WorkerRegistration / WorkerHeartbeat
ScheduledReconciliationJob
```

Database foreign keys and project IDs on job/process records must make cross-project mismatches impossible to ignore. A release cannot reference another project's feature; a job cannot reference a task artifact from another project.

### 6.5 Security model

- Treat every configured repository and task file as trusted administrator input but still validate paths and file shapes defensively.
- Restrict filesystem access to allowlisted workspace roots and resolve real paths after every user-provided relative path join.
- Spawn fixed executables with argument arrays; never concatenate task paths into shell commands.
- Use a minimal worker service account and the least GitHub permissions compatible with pushing branches and managing PR metadata.
- Keep credentials in deployment secrets/configuration, never normal project database fields.
- Redact common token, authorization, cookie, and credential patterns before persistence or display.
- Escape all task, note, log, Git, and GitHub text in the UI; none is trusted HTML.
- Record security-sensitive configuration and process-control actions in the audit trail.
- Do not expose arbitrary file browsing or log-file path APIs.

### 6.6 Idempotency and consistency

- Use stable operation keys for approve/queue, retry, cancel, push, create PR, and poll reconciliation.
- Enforce invariants in both domain logic and database constraints where possible.
- External effects shall use an outbox or equivalent persisted intent so a process crash between database commit and GitHub/Git action can be reconciled safely.
- PR reconciliation shall prefer GitHub's observed state over cached state but shall validate repository, head branch, and base branch before transition.
- A newer task snapshot or PR head SHA shall never be overwritten by an older poll result.

### 6.7 Observability

- Use correlation IDs spanning HTTP requests, jobs, process attempts, Git operations, GitHub calls, activities, and audits.
- Emit structured application logs with project/feature IDs but no secrets.
- Track queue depth, active jobs, oldest queued age, worker heartbeat age, job durations, interrupted attempts, adapter errors, polling lag, and attention counts.
- The Settings/status UI shall show whether worker capacity, Autopilot, database, and GitHub authentication are healthy.

### 6.8 Risks and mitigations

| Risk | Impact | Phase 1 mitigation |
|---|---|---|
| Existing worktree contains unrelated changes | Wrong code enters a feature branch or is lost | Dedicated workspace expectation, strict preflight, never reset or discard automatically |
| Worker dies while child process survives | Duplicate work or repository corruption | Persist verified process identity, terminate orphan, mark interrupted, require manual retry |
| CLI output or internals change | Progress parser breaks | Stable `AutopilotRunner`, schema/version checks, structured files first, contract tests against current CLI |
| Task JSON is temporarily invalid while being written | False failure or corrupt snapshot | Atomic/tolerant reads, retain last valid snapshot, bounded retry |
| Double tap or network retry | Duplicate job or PR | Idempotency keys, unique active-job/branch/PR constraints, external reconciliation |
| Two projects point at the same repository path | Cross-feature collision | Canonical path uniqueness and one active job per project; reject duplicate active project roots |
| GitHub polling misses or reorders events | Stale/incorrect workflow state | Current-head checks, monotonic observations, persisted scheduled polling and reconciliation |
| Raw logs leak credentials | Security incident | Minimal environment, redaction before persistence, bounded access, no secret audit metadata |
| Container cannot access CLI auth or workspaces | Jobs fail at runtime | Startup/readiness validation and explicit Compose mounts/secrets documentation |
| Phase 1 terminal state is mistaken for release completion | Premature delivery decisions | Explicit **Development Merged** wording and development-only progress metrics |

### 6.9 Future phases

The architecture shall preserve extension points for, but shall not implement:

1. **Phase 2:** asynchronous web-based PRD discovery, clarification, editing, revision, and approval.
2. **Phase 3:** web-based task generation, richer dependency visualization, editing, and separate review workflows.
3. **Phase 4:** bounded autonomous repair for CI, test, review, and deployment failures.
4. **Phase 5:** DEV deployment/test/manual gate, UAT promotion/deployment/test/manual gate, GitHub Release creation, production deployment, and release completion.
5. Later capabilities may add webhooks, outbound notifications, configurable gates, additional workers, worktree-based same-project concurrency, other source-control providers, and multi-user RBAC.

## 7. Phase 1 Acceptance Criteria

Phase 1 is acceptable for approval only when all of the following are demonstrated:

1. An unauthenticated visitor cannot access portfolio data or invoke any operation; the sole administrator can log in, use a secure session, and log out.
2. The owner can register an existing repository only when its canonical path, Git identity, development branch, global `autopilotagent`, `gh` authentication, and GitHub repository access validate.
3. The owner can create projects, releases, and features; the global home screen remains the default and summarizes all projects.
4. A feature accepts only a safe, valid project-relative task JSON path and renders its requirements, dependencies, acceptance criteria, TDD states, and blockers without requiring raw JSON inspection.
5. Development cannot queue before the owner explicitly approves the current task checksum through **Approve & Queue Development**.
6. The approval and initial queue record are atomic and duplicate submissions create only one attempt.
7. Four jobs from four projects can run concurrently, a fifth remains queued, and two jobs for the same project never run concurrently.
8. Starting development returns promptly; closing the browser has no effect on the worker or Autopilot process.
9. The worker creates the deterministic branch from the configured development branch and invokes `autopilotagent` with a validated argument array from the correct project root.
10. Feature and job views rebuild accurate requirement-level progress from persisted snapshots after browser, API, or web restarts.
11. A successful process with every task passing moves through development completion to exactly one pushed branch and one GitHub PR.
12. A zero exit with stuck, invalid, or unpassed requirements does not create a PR and surfaces an actionable failure.
13. Cancellation first requests graceful stop, escalates after timeouts, preserves evidence, and never kills an unrelated process.
14. A worker/process interruption is marked **Development Interrupted** and never automatically restarted; a verified explicit retry creates a new attempt on the same feature branch.
15. Console polls GitHub without an open browser, shows current-head CI status, surfaces failures and requested changes under **Needs Your Attention**, and recovers when external fixes change the PR.
16. Console never exposes a PR merge action and never merges automatically.
17. An externally merged PR is detected and moves the feature to **Development Merged**; its release updates development progress without being labeled released or production-ready.
18. The attention view includes every Phase 1 human decision or intervention state and excludes healthy automated waiting states.
19. The complete create → attach → approve → queue → develop → PR → CI → review → merge-detected journey is usable at a 375-pixel viewport and passes the defined accessibility checks.
20. Every human and automated state change is reconstructable from append-only audit and structured activity records without relying on raw terminal output.
21. Path traversal, symlink escape, repository mismatch, dirty unrelated worktree state, duplicate active process, duplicate PR, and stale poll-result tests all pass.
22. Typecheck, lint, unit tests, integration tests, end-to-end tests, and configured coverage gates pass with no flaky critical-path tests.

## 8. Approval and Next Step

This PRD is intended for human review. Implementation must not begin until it is explicitly approved. After approval, generate a machine-readable task file with:

```text
/tasks docs/autopilotagent/autopilot-console-phase-1/autopilot-console-phase-1.md
```
