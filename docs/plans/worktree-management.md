# Plan: Worktree Management

## Context

A pi extension for managing git worktrees from within a session — creating isolated workspaces for concurrent work and cleaning them up when done. See [brainstorm](../brainstorms/worktree-management.md).

## Architecture

### Impacted Modules

None. This is a standalone extension that doesn't modify existing modules.

### New Modules

**Worktree** — a new extension at `extensions/worktree/`. Registers two slash commands (`/worktree create`, `/worktree cleanup`) for creating worktrees with branch setup, handling pending changes, and merging/cleaning up when done.

**Responsibilities:** worktree lifecycle (create, switch-to, cleanup), branch creation, stash management, merge orchestration (delegates to agent), session transitions, autocomplete for branch names.

**Dependencies:** pi core (session management APIs, tool creation APIs, command registration, `before_agent_start` event), git CLI.

### Interfaces

**`/worktree create <branch-name> [base-branch]`**

1. Check if worktree already exists for `<branch-name>` (via `git worktree list`).
   - If yes: transition session to existing worktree directory, done.
   - If no: continue to step 2.
2. If working tree is dirty (`git status --porcelain`), ask user via `ctx.ui.select`: bring changes or leave them.
3. If bringing changes: `git stash push` (staged + unstaged; untracked left behind).
4. Create worktree: `git worktree add ~/.git-worktrees/<repo-name>/<branch-name> -b <branch-name> [base-branch]`. Base defaults to current branch.
5. If stash was created: `git -C <worktree-path> stash pop`.
6. Transition session to worktree directory (see blocker below).

**`/worktree cleanup [merge-target]`**

1. Send user message via `pi.sendUserMessage()` instructing agent to merge current branch into `merge-target` (default: `main`). The agent performs the merge as bash tool calls and handles conflicts naturally.
2. `ctx.waitForIdle()` — wait for agent to finish.
3. Check `git status --porcelain` — if dirty, notify user and return control. User can resolve and re-run `/worktree cleanup`.
4. If clean:
   - Derive original repo path from `git worktree list` (main worktree is first entry).
   - From original repo dir: `git worktree remove <worktree-path>`, `git branch -d <branch-name>`.
   - Transition session to original repo directory, starting a new session (no conversation carry-over).

**Worktree location:** `~/.git-worktrees/<repo-name>/<branch-name>` where `<repo-name>` is the basename of the git repo root.

**Autocomplete:** `getArgumentCompletions` provides branch name completions via `git branch --list`.

**State:** No persistent state. Original repo path derived from `git worktree list`. Merge target specified at cleanup time (default `main`).

## Blocked

**The extension cannot change the working directory of a running pi session.**

All core tools (bash, read, edit, write) capture the cwd at session creation time via `createAllTools(this._cwd)`. The `_cwd` field on `AgentSession` is set once in the constructor and never updated. There is no `setCwd()` API, and `switchSession()` does not update the tool cwd — it loads conversation history but tools continue operating in the original directory.

**Workaround considered and rejected:** The SSH extension example (`examples/extensions/ssh.ts`) demonstrates registering replacement tools that delegate to custom operations. The worktree extension could use the same pattern — register overrides for bash/read/edit/write that dynamically resolve the cwd. This was rejected because:
- It's a hack that reimplements core tool plumbing in an extension.
- It's fragile — any upstream changes to tool behavior would need to be mirrored.
- It doesn't update the session's actual cwd, so session files, extension discovery, skill discovery, and other cwd-dependent behavior would still point at the original directory.

**What's needed upstream:** An API on `AgentSession` (or exposed via `ExtensionCommandContext`) to change the working directory mid-session — updating `_cwd`, rebuilding base tools via `_buildRuntime`, and updating the `SessionManager` cwd. Something like `ctx.setCwd(newPath)`.

**Next step:** Open a discussion or issue on [badlogic/pi-mono](https://github.com/badlogic/pi-mono) requesting a `setCwd` capability for extensions.
