# Review: Worktree Management

**Plan:** `docs/plans/worktree-management.md`
**Diff range:** `aa8420bf35e4d64885d0ff9f18997c064e9551dd..e999136a70fcc6ffbb59eaf45761330eba5a723a`
**Date:** 2026-04-05

## Summary

All three plan steps were implemented faithfully — create orchestration, cleanup orchestration, and the real adapter wiring in `index.ts` all match the architecture's session-replacement model and the plan's specified flows. No plan deviations found. The code correctness pass surfaced four warnings around error recovery and edge-case handling, none of which affect the happy path but each of which could cause confusing failures under real-world conditions.

## Findings

### 1. Stash orphaned if worktree creation or session setup fails

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/worktree/controller.ts:69-91`
- **Status:** open

If `git.addWorktree()`, `sessions.create()`, `sessions.forkFrom()`, or `runtime.switchSession()` throws after `stashPush` succeeded, the stash is never popped. The user's tracked changes are silently hidden in the stash with no notification or recovery path. A try/finally around the post-stash operations (or at minimum a catch that notifies the user their changes are stashed) would prevent silent data loss.

### 2. Cleanup from the main worktree has no guard

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/worktree/controller.ts:96-120`
- **Status:** open

There is no check against running `/worktree cleanup` from the main worktree. If the user does so, `requireWorktreeAtPath` finds the main worktree entry, and `removeWorktree` runs `git worktree remove` on it — which git refuses with a fatal error (`'path' is a main working tree`). The result is an unhandled exception after the merge has already been performed. A guard like `if (currentWorktree.isMain)` with a user-friendly notification should precede the destructive operations.

### 3. Cleanup with detached HEAD passes empty branch name

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/worktree/controller.ts:97-116`
- **Status:** open

If the current worktree is in a detached HEAD state, `git branch --show-current` returns an empty string. `parseWorktreeList` assigns `branch: ""` for entries without a branch line. This cascades: `buildCleanupMergePrompt` produces a merge prompt with an empty branch name, `deleteBranch` runs `git branch -d ''` which errors, and the merge instruction to the agent is nonsensical. The cleanup method should validate that the current branch is non-empty before proceeding.

### 4. Potential null dereference in `continueRecent` session adapter

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/worktree/index.ts:223-226`
- **Status:** open

The `continueRecent` adapter calls `SessionManager.continueRecent(cwd, sessionDir).getSessionFile()` without null-checking the intermediate return value. The contract declares `continueRecent` returns `Promise<string | undefined>`, meaning the "no recent session" case should return `undefined`. If `SessionManager.continueRecent()` returns `null` or `undefined` instead of an object with a `getSessionFile()` method, this throws a `TypeError`. The `create` and `forkFrom` adapters handle `.getSessionFile()` results — `continueRecent` should guard the intermediate value or document the assumption that the static method always returns a non-null object.

### 5. Partial cleanup: worktree removed but branch deletion can fail

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/worktree/controller.ts:107-116`
- **Status:** open

`removeWorktree` is called before `deleteBranch` with `force: false` (`git branch -d`). If the branch has unmerged commits (e.g., the agent's merge was incomplete despite a clean working tree), branch deletion fails after the worktree has already been removed. The state is recoverable (`git branch -d` manually), but the user gets an unhandled exception after their worktree is gone. Consider catching the branch deletion error and notifying gracefully, or reversing the order.

## No Issues

Plan adherence: no significant deviations found. All three implementation steps match the plan's specified flows, the architecture's session-replacement model, and the interface contracts. Test files and contract files are immutable — no changes between `pre-implementation-commit` and HEAD. Reasonable adaptations during implementation (dynamic SessionManager resolution, defensive API guards, parent directory creation for worktrees) are well-motivated and don't alter the plan's intent.
