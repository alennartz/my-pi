# Plan: Worktree Management

## Context

A pi extension for managing git worktrees from within a session — creating isolated workspaces for concurrent work and cleaning them up when done. See [brainstorm](../brainstorms/worktree-management.md).

## Architecture

### Impacted Modules

None. This is a standalone extension that doesn't modify existing modules.

### New Modules

**Worktree** — a new extension at `extensions/worktree/`. Registers two slash commands (`/worktree create`, `/worktree cleanup`) for creating worktrees with branch setup, handling pending changes, and merging/cleaning up when done.

**Responsibilities:** worktree lifecycle (create, resume, cleanup), branch creation, stash management, merge orchestration (delegates to agent), cross-cwd session transitions, autocomplete for branch names.

**Dependencies:** pi core (extension command APIs, `SessionManager.create`, `SessionManager.forkFrom`, `ctx.switchSession`, `ctx.waitForIdle`), git CLI.

### Interfaces

**`/worktree create <branch-name> [base-branch]`**

1. Check if worktree already exists for `<branch-name>` (via `git worktree list`).
   - If yes: resume the most recent persisted session for that worktree cwd if one exists; otherwise create a fresh persisted session rooted there. Then `ctx.switchSession(...)` into it, done.
   - If no: continue to step 2.
2. Ask whether to bring the current session context into the new worktree.
   - Yes: preserve conversation history by forking the current persisted session into the worktree cwd.
   - No: start a fresh persisted session in the worktree cwd.
   - This question is only asked when creating a new worktree, not when resuming an existing one.
3. If working tree is dirty (`git status --porcelain`), ask user via `ctx.ui.select`: bring changes or leave them.
4. If bringing changes: `git stash push` (staged + unstaged; untracked left behind).
5. Create worktree: `git worktree add ~/.git-worktrees/<repo-name>/<branch-name> -b <branch-name> [base-branch]`. Base defaults to current branch.
6. If stash was created: `git -C <worktree-path> stash pop`.
7. Transition to a session rooted at the worktree directory:
   - For the context-preserving path, use `SessionManager.forkFrom(currentSessionFile, <worktree-path>)`.
   - For the fresh-start path, use `SessionManager.create(<worktree-path>)`.
   - `ctx.switchSession(<target-session-file>)` enters the worktree with rebuilt cwd-bound runtime state.

**`/worktree cleanup [merge-target]`**

1. Send user message via `pi.sendUserMessage()` instructing agent to merge current branch into `merge-target` (default: `main`). The agent performs the merge as bash tool calls and handles conflicts naturally.
2. `ctx.waitForIdle()` — wait for agent to finish.
3. Check `git status --porcelain` — if dirty, notify user and return control. User can resolve and re-run `/worktree cleanup`.
4. If clean:
   - Derive original repo path from `git worktree list` (main worktree is first entry).
   - From original repo dir: `git worktree remove <worktree-path>`, `git branch -d <branch-name>`.
   - Create a fresh persisted session rooted at the original repo with `SessionManager.create(<original-repo-path>)`, then `ctx.switchSession(<new-session-file>)` into it. This is intentionally a fresh session rather than a fork — cleanup is the end of the isolated worktree conversation.
   - Branch deletion always uses `git branch -d`; do not prompt and do not force-delete.

**Worktree location:** `~/.git-worktrees/<repo-name>/<branch-name>` where `<repo-name>` is the basename of the git repo root.

**Autocomplete:** `getArgumentCompletions` provides branch name completions via `git branch --list`.

**State:** No persistent state. Original repo path derived from `git worktree list`. Merge target specified at cleanup time (default `main`).

### Session Transition Mechanics

Recent pi releases added runtime-backed session replacement. Cross-session transitions now rebuild cwd-bound runtime state — tools, resource discovery, and session plumbing are recreated for the target cwd rather than reusing the original session's cwd.

That removes the original blocker for this extension. The implementation should model worktree moves as **session replacement**, not in-place cwd mutation:

- **Create worktree:** ask whether to bring session context, then either fork or create a fresh session in the worktree cwd and `ctx.switchSession(...)` into it.
- **Resume worktree:** reopen the most recent session for that worktree cwd when available; otherwise create a fresh one there.
- **Cleanup back to main repo:** after merge + cleanliness checks + worktree removal, create a fresh session rooted at the original repo cwd and switch to it.

The key APIs are:

- `SessionManager.forkFrom(sourceSessionFile, targetCwd)` to preserve conversation history while relocating it into the target cwd's session space.
- `SessionManager.create(targetCwd)` to start a fresh persisted session in a different cwd.
- `ctx.switchSession()` to activate the target session via pi's runtime replacement path so cwd-bound services are rebuilt correctly for the worktree.

`ctx.newSession()` is not the cross-cwd primitive here. Worktree transitions should be modeled as "create or fork a session in the target cwd, then switch to it."

This makes fork an optional continuity mechanism rather than a foundational requirement: use it only when the user explicitly wants to bring the current session context into a newly created worktree.

## Tests

**Pre-test-write commit:** `aa8420bf35e4d64885d0ff9f18997c064e9551dd`

### Interface Files

- `extensions/worktree/contracts.ts` — worktree command request types plus the git, session, agent, runtime, and autocomplete contracts the implementation will orchestrate.
- `extensions/worktree/command-surface.ts` — slash-command parsing, centralized worktree path resolution, merge prompt construction, and autocomplete shaping for the `/worktree` surface.
- `extensions/worktree/controller.ts` — controller boundary that will implement `/worktree create` and `/worktree cleanup` against the declared dependencies.
- `extensions/worktree/index.ts` — extension entrypoint that registers the `/worktree` command and wires it to the command-surface helpers and controller boundary.
- `extensions/worktree/package.json` — pi package metadata exposing the new worktree extension entrypoint.

### Test Files

- `extensions/worktree/command-surface.test.ts` — verifies `/worktree` argument parsing, default values, branch autocomplete shaping, worktree path placement, and merge-instruction prompt wording.
- `extensions/worktree/controller.test.ts` — red-phase behavioral tests for create/resume/cleanup orchestration across mocked git, session, agent, and runtime boundaries.

### Behaviors Covered

#### Worktree Command Surface

- Parses `/worktree create <branch-name> [base-branch]` into a create request with the branch name required and the base branch optional.
- Rejects malformed create invocations before any git or session work begins.
- Parses `/worktree cleanup [merge-target]` and defaults the merge target to `main` when omitted.
- Rejects malformed cleanup invocations before any merge orchestration begins.
- Suggests `create` and `cleanup` before a subcommand is chosen.
- Suggests git branch names in the create branch slot, create base-branch slot, and cleanup merge-target slot.
- Resolves new worktree directories under `~/.git-worktrees/<repo-name>/<branch-name>`.
- Builds the cleanup merge instruction so the agent is explicitly told which current branch to merge into which target using bash tool calls.

#### Worktree Controller

- Reuses an existing worktree by continuing the most recent session in that worktree cwd without re-prompting for context transfer or pending-change handling.
- Creates a new worktree from the current branch when no base branch is provided and the user chooses a fresh session.
- Stashes tracked changes before creating a new worktree and reapplies them inside the new worktree when the user chooses to bring changes along.
- Sends the cleanup merge instruction, waits for the agent to go idle, and returns control without removal when the worktree is still dirty after merge.
- Removes the worktree from the main repo, deletes the branch with non-force `-d` semantics, and switches to a fresh main-repo session when cleanup finishes cleanly.
