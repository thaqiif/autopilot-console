# Autopilot CLI branch compatibility

## Problem

Console persists and pushes the deterministic branch:

```text
feature/<feature-id>-<sanitized-slug>
```

The current autopilotagent slash command (`commands/autopilotagent.md`) derives a
branch from the **task file basename** and runs:

```bash
git checkout <feature-name> 2>/dev/null || git checkout -b <feature-name>
```

where `<feature-name>` is the task basename without extension (e.g. `demo` for
`docs/autopilotagent/demo/demo.json`). That checkout can divert commits away from
the Console-owned `feature/<feature-id>-<slug>` ref.

Phase 1 forbids forking the engine, force push, history rewrite, branch deletion,
destructive reset, and rewriting the task file merely to change the basename.

## Strategy (non-destructive)

Before spawning `autopilotagent`:

1. Ensure the deterministic `expectedBranch` already exists (created by Git
   preflight from the remote development branch).
2. Compute `taskBasename` from the validated relative task path.
3. Create or update a **local-only** branch named `taskBasename` that points at
   the **same commit** as `expectedBranch` (`git branch -f <basename> <expected>`
   when already present, or `git branch <basename> <expected>`).
4. Leave HEAD on `expectedBranch` (or on `taskBasename` if they are identical
   tips — both refer to the same object).

After the run (before push):

1. Observe HEAD and both refs.
2. If the agent checked out `taskBasename` and made commits, those commits are
   descendants of the pre-run tip shared with `expectedBranch`.
3. Reconcile with a **fast-forward only** update of `expectedBranch` to the
   `taskBasename` tip (`git merge --ff-only` or `git update-ref` when ancestor).
4. Push only `expectedBranch` to the configured remote. Never push the basename
   branch as the feature PR head.

If `taskBasename` tip is not a fast-forward of `expectedBranch` (divergent
history, unrelated branch), fail with a safe, redacted error and require human
attention. Do **not** force-push, reset hard, delete branches, or rewrite
history.

## Forbidden operations

- Never force push (any force flag on `git push`, including lease variants)
- No history rewrite (`rebase`, `filter-branch`, `commit --amend` of foreign history)
- Never delete branch of the feature or basename refs as part of this strategy
- Hard reset, clean -fd, discarding unrelated worktree changes
- Engine fork or task-file rewrite solely to change the basename branch name

## Contract tests

- Fake executable suite asserts spawn argv/cwd/env and identity checks without
  the real CLI.
- Opt-in installed-CLI suite (`AUTOPILOT_INSTALLED_CLI_TEST=1`) pins `run.pid`,
  `SIGUSR1`, and basename checkout documentation so regressions surface when
  autopilot-multi behavior changes.
