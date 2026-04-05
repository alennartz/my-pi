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
- `extensions/worktree/index.test.ts` — verifies `/worktree` command registration plus handler/autocomplete wiring between the extension entrypoint, command-surface helpers, and controller boundary.
- `extensions/worktree/controller.test.ts` — red-phase behavioral tests for create/resume/cleanup orchestration across mocked git, session, agent, and runtime boundaries, including resume fallback and cancelled create interactions.

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

#### Worktree Extension Entrypoint

- Registers the `/worktree` command with the extension API.
- Dispatches parsed create and cleanup requests to the controller boundary.
- Notifies the user with the parser usage message instead of calling the controller when command parsing fails.
- Wires branch-name autocomplete through `git branch --list` and the command-surface helper.

#### Worktree Controller

- Reuses an existing worktree by continuing the most recent session in that worktree cwd without re-prompting for context transfer or pending-change handling.
- Falls back to creating a fresh session when resuming an existing worktree that has no persisted session yet.
- Treats a cancelled session switch during resume as a terminal return rather than retrying alternate session flows.
- Creates a new worktree from the current branch when no base branch is provided and the user chooses a fresh session.
- Returns without side effects when the user cancels either the context-transfer prompt or the pending-changes prompt during create.
- Stashes tracked changes before creating a new worktree and reapplies them inside the new worktree when the user chooses to bring changes along.
- Sends the cleanup merge instruction, waits for the agent to go idle, and returns control without removal when the worktree is still dirty after merge.
- Removes the worktree from the main repo, deletes the branch with non-force `-d` semantics, and switches to a fresh main-repo session when cleanup finishes cleanly.

**Review status:** approved

## Steps

**Pre-implementation commit:** `a9149de293808c97309c284deb57d30c117f8c5a`

### Step 1: Implement create orchestration in `controller.ts`

Replace the `notImplemented()` placeholder in `extensions/worktree/controller.ts` with the real `/worktree create` flow, plus small pure helpers for worktree lookup. Start by loading `const worktrees = await git.listWorktrees(env.cwd)` and checking for an existing entry whose `branch` matches `request.branchName`. For that resume path, call `await sessions.continueRecent(existing.path)` and fall back to `await sessions.create(existing.path)` when it returns `undefined`, then `await runtime.switchSession(sessionFile)` and return without prompting for context transfer or pending changes.

For a brand-new worktree, implement the ordered flow the tests describe: prompt `runtime.chooseContextTransfer()` and return immediately on `undefined`; inspect `await git.getStatusPorcelain(env.cwd)` and, when non-empty, prompt `runtime.choosePendingChanges()` and return on cancellation; call `git.stashPush(env.cwd)` only for the `"bring-changes"` branch; compute `const baseBranch = request.baseBranch ?? await git.getCurrentBranch(env.cwd)`; build `const worktreePath = resolveWorktreePath(env.homeDirectory, env.repoName, request.branchName)`; then call `git.addWorktree({ cwd: env.cwd, path: worktreePath, branchName: request.branchName, baseBranch })`. After creation, call `git.stashPop(worktreePath)` only if `stashPush()` reported that a stash was actually created, then choose the target session with `sessions.create(worktreePath)` for `"fresh-session"` or `sessions.forkFrom(env.currentSessionFile, worktreePath)` for `"bring-context"`, and finish with `runtime.switchSession(...)`.

**Verify:** `npx vitest run extensions/worktree/controller.test.ts -t "create"`
**Status:** done

### Step 2: Implement cleanup orchestration in `controller.ts`

Complete `/worktree cleanup` in the same file using the existing `buildCleanupMergePrompt()` helper from `extensions/worktree/command-surface.ts`. The method should read `const currentBranch = await git.getCurrentBranch(env.cwd)`, send `buildCleanupMergePrompt(currentBranch, request.mergeTarget)` through `agent.sendMergeInstruction(...)`, then `await runtime.waitForIdle()` before touching sessions or worktrees.

After the agent finishes, inspect `await git.getStatusPorcelain(env.cwd)`. If it is still non-empty, notify the user through `runtime.notify(..., "warning")` and return without calling `removeWorktree`, `deleteBranch`, or creating a new session. If the worktree is clean, reload `git.listWorktrees(env.cwd)`, find the main repository entry via `isMain`, find the current worktree entry via `path === env.cwd`, and run the cleanup sequence from the main repo root: `git.removeWorktree({ cwd: mainRepo.path, worktreePath: currentWorktree.path })`, `git.deleteBranch({ cwd: mainRepo.path, branchName: currentWorktree.branch, force: false })`, `const sessionFile = await sessions.create(mainRepo.path)`, then `await runtime.switchSession(sessionFile)`. Keep cleanup as a fresh-session return to the main repo; do not add any fork/resume behavior here.

**Verify:** `npx vitest run extensions/worktree/controller.test.ts -t "cleanup"`
**Status:** done

### Step 3: Wire real git/session/runtime adapters in `index.ts`

Turn `extensions/worktree/index.ts` from a test stub into the real extension boundary. Instead of constructing one context-free controller at module load, add a `createDependencies(pi, ctx): WorktreeDependencies` helper and call `createWorktreeController(createDependencies(pi, ctx))` inside the command handler so each invocation is bound to the current cwd, session, and UI context.

In that dependency factory, add a small git command wrapper and implement the concrete `WorktreeGitClient` methods the controller now depends on: branch listing for autocomplete, `git worktree list --porcelain` parsing into `WorktreeInfo[]`, `git status --porcelain`, tracked-only stash push/pop, `git worktree add/remove`, and `git branch -d`. Normalize `env.cwd` to the repo/worktree root (for example via `git rev-parse --show-toplevel`) before building `WorktreeEnvironment`, and derive `env.repoName` from that root so controller path comparisons line up with `git worktree list` output even when `/worktree` is run from a nested directory. Wrap session calls with `SessionManager.continueRecent/create/forkFrom`, passing `ctx.sessionManager.getSessionDir()` so new worktree sessions stay in the same session storage as the current session, and read `ctx.sessionManager.getSessionFile()` for the optional fork source. Wire `agent.sendMergeInstruction` to `pi.sendUserMessage`, wire `waitForIdle`, `switchSession`, and `notify` directly from `ctx`, and implement `chooseContextTransfer` / `choosePendingChanges` with the existing UI primitives (`ctx.ui.select` or `showNumberedSelect` from `lib/components/numbered-select.ts`) so cancellation returns `undefined` and selections map cleanly onto the contract enums.

Keep the existing `parseWorktreeCommand()` and `getWorktreeArgumentCompletions()` flow intact; the only command-surface work here should be consuming those helpers, not re-parsing arguments in `index.ts`.

**Verify:** `npx vitest run extensions/worktree/command-surface.test.ts extensions/worktree/index.test.ts extensions/worktree/controller.test.ts`
**Status:** in progress
