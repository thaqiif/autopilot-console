Autopilot Console — Product Vision and Initial Requirements

I want to build a new self-hosted application called Autopilot Console.

Autopilot Console is a mobile-friendly, web-based control plane for managing autonomous software development across multiple software projects.

I already have an existing project called autopilot-multi.

autopilot-multi is the autonomous development engine. It currently provides the workflow for:

* creating PRDs
* generating implementation task JSON
* executing requirements autonomously
* TDD development
* unit tests
* linting
* test coverage
* committing changes after tasks
* running Claude Code repeatedly until all requirements are completed

Do NOT reimplement the autonomous TDD engine as part of this project.

Autopilot Console should sit ABOVE autopilot-multi and orchestrate the entire software delivery lifecycle.

The long-term goal is that I act primarily as a Product Manager and final approver, while autonomous agents handle most repetitive software engineering and delivery work.

⸻

Core Philosophy

The browser is only a control panel.

All actual development work must run server-side as durable background jobs.

Closing the browser, closing the mobile app, losing internet connectivity, or switching devices must NOT stop:

* PRD generation
* task generation
* Autopilot development runs
* Claude Code sessions
* testing
* CI monitoring
* deployment monitoring
* automated failure recovery

I should be able to start something from my phone, close Safari, and return hours later to see the current state.

The server must persist all workflow state.

⸻

Primary User

Initially this is a single-user, self-hosted application.

I am the Product Manager / owner of all projects.

My responsibilities should eventually be limited primarily to:

1. Decide which features belong in a release.
2. Refine and approve feature requirements and PRDs.
3. Review generated implementation tasks when necessary.
4. Review feature PRs.
5. Perform manual DEV UI/UX and integration testing.
6. Approve promotion to UAT.
7. Perform final UAT testing.
8. Approve production releases.

Everything deterministic between these human approval gates should be automated.

⸻

Multi-Project Requirement

The system must support multiple independent software projects.

Examples:

* QuranReady
* MY Waktu Solat
* BakiDompet
* QuickDiff
* future projects

The main dashboard should show ALL projects together.

I do NOT want the application to open directly into a single project’s dashboard.

The global dashboard should give me an immediate overview of my entire development portfolio.

Example:

* projects currently developing
* features waiting for my attention
* DEV-ready features
* UAT-ready features
* failed jobs
* active agents/workers
* queued work
* releases ready for production

There should be a global “Needs Your Attention” view.

This is one of the most important screens.

The goal is that I should not need to inspect every project to determine whether an agent needs me.

The application should surface only workflows requiring human intervention.

Examples:

* PRD needs clarification
* PRD ready for approval
* tasks ready for review
* PR ready for review
* DEV ready for manual testing
* UAT ready for manual testing
* release ready for production
* autonomous repair has failed repeatedly and requires intervention

⸻

Core Domain Hierarchy

The high-level model should be:

Workspace
→ Projects
→ Releases
→ Features
→ PRD
→ Tasks
→ Development Run
→ Pull Request
→ DEV
→ UAT
→ Production

A workspace contains multiple projects.

A project contains multiple releases.

A release contains multiple features.

A feature moves through a defined software delivery state machine.

⸻

Projects

Each project should have configurable integration settings.

Example configuration:

* project name
* GitHub repository
* local/server workspace path
* default development branch
* UAT branch
* production branch
* DEV environment URL
* UAT environment URL
* production URL
* GitHub Actions workflows
* deployment workflow information
* Autopilot configuration
* testing configuration

Example:

Project: QuranReady

Repository:
thaqiif/quranready

Branches:

* development: develop
* UAT: uat
* production: main

Environments:

* DEV: configured URL
* UAT: configured URL
* Production: configured URL

Each project repository may already contain its own autopilot.json.

Autopilot Console should use the project’s existing Autopilot configuration rather than attempting to replace it.

⸻

Releases

I primarily plan development by RELEASE, not by sprint.

For example:

v1.8.0

Features:

* Personalized reminders
* Reader performance improvements
* New streak system
* Reading statistics
* Profile redesign

A release should show overall progress based on its features.

Example:

v1.8.0
3 / 5 features complete

Features may be in different stages simultaneously.

For example:

* Feature A: UAT Ready
* Feature B: DEV Ready
* Feature C: Developing
* Feature D: Tasks Review
* Feature E: PRD Discovery

The system should not require sprint management.

Sprint support may be considered later but is NOT part of the initial core model.

⸻

Feature Lifecycle

A feature should move approximately through the following states:

PLANNED

PRD_DISCOVERY

PRD_REVIEW

TASKS_GENERATING

TASKS_REVIEW

READY_FOR_DEVELOPMENT

QUEUED

DEVELOPING

DEVELOPMENT_FAILED

DEVELOPMENT_COMPLETE

PR_CREATING

PR_REVIEW

PR_CHANGES_REQUESTED

CI_RUNNING

CI_REPAIRING

DEV_DEPLOYING

DEV_DEPLOYMENT_FAILED

DEV_AUTOMATED_TESTING

DEV_READY

DEV_MANUAL_TESTING

UAT_PROMOTION

UAT_DEPLOYING

UAT_AUTOMATED_TESTING

UAT_READY

UAT_MANUAL_TESTING

RELEASE_READY

RELEASED

BLOCKED

The exact state model should be refined during PRD creation.

Transitions should distinguish between:

1. deterministic automated transitions
2. agent-driven reasoning transitions
3. human approval transitions

⸻

PRD Experience

Currently I use Claude Code /prd through the terminal.

I want to eventually move this experience into Autopilot Console.

The UI should allow me to:

1. Create a feature.
2. Enter my initial idea or rough requirements.
3. Start PRD generation.
4. Have Claude analyze the idea and project/codebase context.
5. Ask me clarification questions.
6. Answer clarification questions through the web UI.
7. Continue the Claude conversation asynchronously.
8. Generate the final PRD.
9. Display the PRD in a readable UI.
10. Allow editing or requesting revisions.
11. Approve the PRD.

The experience should be optimized for mobile.

Claude clarification questions should ideally be presented as structured UI where possible:

* multiple choice
* yes/no
* text input
* multi-line explanation

A normal chat-style input should remain available for complex answers.

The first implementation does NOT necessarily need to support every interactive PRD capability if integrating the current /prd workflow is difficult.

It is acceptable to design this incrementally.

However, the architecture should anticipate interactive server-side Claude sessions.

⸻

Tasks Experience

After PRD approval, I currently manually run /tasks.

Autopilot Console should eventually generate implementation tasks automatically.

The task generation process should use the approved PRD and inspect the relevant codebase.

The resulting JSON should remain compatible with autopilot-multi.

The UI should visualize the JSON rather than forcing me to read raw JSON.

For each requirement/task show:

* ID
* title
* description
* acceptance criteria
* dependencies
* status
* TDD state
* blocked reason
* completion information

The UI should show dependencies visually where useful.

I should be able to approve the tasks and start development.

⸻

Autonomous Development

Once development is approved, Autopilot Console should create a durable background job.

The background worker should invoke the existing autopilot-multi engine.

Conceptually:

autopilot 

The web request that starts development must return immediately.

The Autopilot process must continue independently.

The system must track:

* job started
* current requirement
* total requirements
* requirement statuses
* commits
* logs
* errors
* blocked requirements
* completion status

The UI should provide a live progress view.

Example:

Development: 7 / 12

Task 1 ✓
Task 2 ✓
Task 3 ✓
Task 4 ✓
Task 5 ✓
Task 6 ✓
Task 7 ● Developing
Task 8 ○
Task 9 ○

Recent activity:

* test created
* RED verified
* implementation completed
* GREEN verified
* refactor completed
* commit created

Do not depend solely on parsing terminal output if there are cleaner ways to observe Autopilot state.

Investigate the existing task JSON, notes files, Git history, hooks, and other structured state exposed by autopilot-multi.

⸻

Background Job Architecture

This is critical.

Long-running work must NOT be tied to browser sessions or HTTP request lifetimes.

Use a durable job model.

Conceptually:

UI
→ API
→ create job
→ persist job
→ worker claims job
→ worker executes process
→ progress persisted
→ UI receives/reloads progress

The system must survive:

* browser closure
* API server restart
* worker restart where recoverable
* temporary network interruption

Consider:

* persistent database
* background workers
* durable job queue
* job heartbeats
* retries
* idempotency
* recovery of interrupted jobs

Do not over-engineer distributed infrastructure for the initial version.

The MVP will likely run on one self-hosted server.

However, design clear boundaries so additional workers can be added later.

⸻

Agent Workers and Concurrency

The system should eventually support several projects being developed concurrently.

Example:

Worker 1:
QuranReady — Streak Redesign

Worker 2:
MY Waktu Solat — Calendar Subscription

Worker 3:
QuickDiff — Fixing CI failure

Worker 4:
Available

The workspace should have a configurable maximum concurrency.

Example:

maximumConcurrentDevelopmentJobs: 4

Additional work should enter a queue.

The global UI should show:

* active workers
* active jobs
* current project
* current feature
* current task
* queued jobs

The implementation should distinguish between a logical job and the OS process executing that job.

⸻

Git Workflow

My current workflow is approximately:

Feature branch
→ PR to develop
→ merge
→ DEV deployment
→ manual DEV test
→ PR develop to UAT
→ merge
→ UAT deployment
→ manual UAT test
→ GitHub Release
→ production deployment

Autopilot Console should automate repetitive Git/GitHub operations.

After autonomous development completes successfully:

1. Run final quality checks.
2. Push the feature branch.
3. Create a GitHub PR targeting develop.
4. Monitor CI.
5. Present the PR to me for review.

The Console must NOT automatically merge the feature PR initially.

This is a human approval gate.

I review and merge the feature PR.

After merge:

1. Detect merge.
2. Monitor DEV deployment.
3. Monitor deployment health/status.
4. Run configured automated smoke/integration/E2E tests.
5. If everything passes, mark DEV_READY.
6. Notify/surface that the feature needs my manual DEV testing.

I perform UI/UX and integration testing manually.

After I approve DEV:

1. Promote toward UAT.
2. Create or manage the develop → UAT promotion.
3. Monitor UAT deployment.
4. Run UAT automated tests.
5. Mark UAT_READY.

I perform final UAT testing.

After I approve the release:

1. Create the GitHub Release.
2. Trigger or allow the configured production deployment.
3. Monitor production deployment.
4. Mark the release as RELEASED.

Exact Git branching behavior should be configurable per project.

Do not hardcode develop, uat, and main globally.

⸻

Failure Handling

Failure handling should be autonomous where reasonable.

Examples:

* failing unit tests
* CI failures
* deployment build errors
* automated integration test failures
* E2E failures

The system should be capable of:

1. detecting the failure
2. collecting relevant logs
3. creating an agent repair job
4. providing relevant context/logs to Claude
5. letting the agent attempt a fix
6. committing/pushing the fix
7. re-running CI or deployment
8. repeating within configured limits

There must be a retry limit.

Example:

maxAutomaticRepairAttempts: 3

After the limit is exceeded:

* mark the feature BLOCKED
* surface it under “Needs Your Attention”
* preserve logs and repair attempts

Do not create infinite autonomous repair loops.

⸻

Human Gates

The initial system should have explicit human gates.

At minimum:

GATE 1:
PRD approval

GATE 2:
Tasks/development approval

GATE 3:
Feature PR approval/review

GATE 4:
DEV manual test approval

GATE 5:
UAT manual test approval / release approval

Some gates may become optional/configurable later.

The system must NEVER silently bypass required human gates.

⸻

Global Dashboard

The default home screen should show all projects together.

Important global metrics:

* number of projects
* active development jobs
* queued jobs
* items needing attention
* failed/blocked jobs
* DEV-ready features
* UAT-ready features
* releases ready for production

The highest-priority section should be:

“Needs Your Attention”

Example cards:

QuranReady
New Reading Goal
PRD ready for approval
[Review PRD]

MY Waktu Solat
Calendar Subscription
DEV deployed and automated tests passed
[Test DEV]

BakiDompet
v0.4.0
UAT passed and ready for production
[Release]

QuickDiff
Export Feature
Deployment failed after automatic repair attempts
[View Problem]

The intention is that I can open the application for 30 seconds and immediately know what requires my decision.

⸻

Global Activity Feed

Provide a cross-project activity feed.

Example:

15:42 QuranReady
Task 8 completed: Implement streak recovery

15:40 MY Waktu Solat
DEV deployment successful

15:38 QuickDiff
Agent attempting to repair failed E2E test

15:31 QuranReady
Commit created

15:24 BakiDompet
UAT smoke tests passed — waiting for release approval

The activity model should be structured data, not merely raw logs.

⸻

Mobile-First UI

The application must be highly usable from an iPhone-sized screen.

Important actions must not require a desktop.

Examples:

* see all project statuses
* review items needing attention
* answer PRD questions
* approve PRD
* review tasks
* start development
* see development progress
* inspect failure summaries
* open GitHub PR
* open DEV
* approve DEV → UAT
* open UAT
* approve production release

Large logs and advanced debugging can be optimized for desktop, but core Product Manager workflows must work well on mobile.

⸻

Suggested Navigation

Desktop may use:

* Overview
* Attention
* Releases
* Projects
* Agents / Workers
* Activity
* Settings

Mobile may use bottom navigation such as:

* Home
* Attention
* Releases
* Projects

Avoid overcrowding mobile navigation.

⸻

GitHub Integration

GitHub should initially be the primary source-control provider.

Required capabilities eventually include:

* repository association
* branch information
* push awareness
* create PR
* read PR state
* read CI/check status
* detect merge
* create release
* monitor GitHub Actions
* collect failed workflow logs where possible

Prefer deterministic GitHub API/CLI operations for deterministic tasks.

Do NOT use an LLM simply to perform predictable operations such as creating a PR or checking whether CI passed.

Use agents only when reasoning is required.

⸻

Deterministic vs Agent Work

This distinction is important.

Deterministic automation:

* queue job
* start process
* push branch
* create PR
* check CI
* monitor deployment
* create promotion PR
* create release
* change workflow state

Agent reasoning:

* refine requirements
* generate PRD
* analyze codebase
* generate implementation tasks
* implement code
* write tests
* investigate failures
* fix failed CI
* fix deployment errors
* address review feedback

Design the architecture around this distinction.

⸻

Technology Direction

Use technologies appropriate for a self-hosted TypeScript application.

My preferred ecosystem includes:

* TypeScript
* Bun
* Hono where appropriate
* React/Next.js where appropriate
* PostgreSQL

Choose the frontend/backend architecture based on maintainability and the background worker requirements rather than blindly following these preferences.

The application should be containerizable and straightforward to deploy on a Linux VPS.

A Docker Compose deployment is desirable.

I expect the application server and workers to have access to persistent project workspaces on disk.

⸻

Repository Architecture

This application should live in a NEW repository separate from autopilot-multi.

Suggested repository name:

autopilot-console

Consider a monorepo structure similar to:

apps/
web/
api/
worker/

packages/
database/
shared/
github/
autopilot/

Exact structure should be chosen after analyzing the requirements.

autopilot-multi should initially be treated as an external execution engine.

Do not tightly couple the Console to undocumented internals unless necessary.

Create an abstraction/interface around Autopilot execution so that the integration can evolve later.

Conceptually:

AutopilotRunner

Responsibilities:

* start run
* stop run
* inspect status
* get progress
* get structured results
* recover/reconcile state

Initial implementation may invoke the existing CLI.

Future implementations may use a more direct programmatic API.

⸻

MVP Priority

Do NOT attempt to implement the entire long-term vision in one massive first release.

Analyze this vision and propose an MVP that creates an end-to-end vertical slice.

The first useful version should prioritize:

1. multi-project dashboard
2. project configuration
3. releases
4. features
5. persistent state machine
6. background job execution
7. integration with existing autopilot CLI
8. development progress
9. GitHub PR creation/status
10. human approval gates
11. mobile-friendly UI

It may be acceptable for the first MVP to continue using the existing terminal /prd and /tasks commands manually.

However, the domain model and architecture should anticipate moving PRD and task generation into the web UI shortly afterward.

A sensible staged rollout might be:

Phase 1:
Multi-project Console + Releases + Features + run existing task JSON + background Autopilot + progress + PR workflow.

Phase 2:
Web-based PRD generation and clarification.

Phase 3:
Web-based task generation/review.

Phase 4:
Autonomous CI/deployment repair loops.

Phase 5:
Full DEV → UAT → production release orchestration.

This staging is only a suggestion. Analyze and improve it.

⸻

Important Engineering Requirements

* Use TDD for implementation.
* Maintain high test coverage.
* Unit-test state transitions thoroughly.
* Integration-test job execution and persistence.
* Ensure background jobs are not dependent on active browser sessions.
* Make state transitions idempotent where possible.
* Prevent duplicate Autopilot runs.
* Prevent duplicate PR creation.
* Prevent duplicate releases.
* Preserve a full audit trail of automated and human actions.
* Treat shell execution as security-sensitive.
* Do not allow arbitrary unauthenticated command execution.
* Design project workspace isolation carefully.
* Ensure one project’s job cannot accidentally operate on another project’s repository.
* Design graceful process cancellation.
* Handle orphaned processes.
* Persist meaningful structured logs/events.
* Do not store secrets directly in normal database fields without considering secure handling.

⸻

What I Want You To Do Now

Do NOT immediately start implementing this entire system.

First:

1. Analyze this product vision.
2. Inspect the existing codebase if one exists.
3. Identify unclear requirements.
4. Ask me detailed product and technical clarification questions.
5. Challenge assumptions where necessary.
6. Identify risks and edge cases.
7. Help reduce the initial scope into a strong MVP.
8. Produce a comprehensive PRD only after the important questions are resolved.

The PRD should clearly define:

* product goals
* non-goals
* personas
* user journeys
* domain model
* feature lifecycle/state machine
* human approval gates
* background job model
* Autopilot integration
* GitHub integration
* worker/concurrency model
* multi-project isolation
* mobile UX
* failure handling
* security considerations
* MVP scope
* future phases
* acceptance criteria

After I review and approve the PRD, I will separately generate implementation tasks.

Do not start implementation until the PRD and implementation tasks have been explicitly approved.