# Worktree Management Extension

## The Idea

A pi extension for managing git worktrees from within a session — creating isolated workspaces for concurrent work and cleaning them up when done. Motivated by working on the same repo in multiple pi sessions where changes occasionally collide; worktrees provide branch-level isolation without leaving the pi workflow.

## Key Decisions

### Session mechanics: fork on create, new session on cleanup
- **Create:** Fork the current session to the worktree directory using `SessionManager.forkFrom`. This preserves conversation context so you can continue the same train of thought in the new workspace. Then `switchSession` to the forked session.
- **Cleanup:** Start a fresh `newSession` in the original repo (no conversation carry-over). By the time you're cleaning up, you're done — the worktree conversation history isn't needed in the main repo.
- **Why:** pi's tools capture cwd at session creation time — there's no `setCwd` API. Session fork/switch is the only mechanism to repoint tools at a different directory while preserving context.

### Extension orchestrates plumbing, agent handles git
- The extension code handles: stashing, worktree creation/deletion, session forking/switching.
- The agent handles: merging branches during cleanup (via `sendUserMessage`). This means merge conflicts are handled naturally by the agent in conversation, not by brittle programmatic conflict resolution.
- **Why:** The merge is the one step that can go wrong in unpredictable ways. Letting the agent handle it means the user gets help with conflicts without the extension needing to anticipate every failure mode.

### Cleanup waits for idle, then checks cleanliness
- After instructing the agent to merge, the extension calls `waitForIdle` then checks `git status`.
- If clean: proceeds with worktree removal and new session.
- If dirty: returns control to the user with a message. User can resolve and run `/worktree cleanup` again.
- **Why:** Simple, robust. No need to parse merge output or handle partial states — just check the end result.

### Worktree location: `~/.git-worktrees/<repo-name>/<branch-name>`
- Central location outside the project directory.
- Grouped by repo name, then branch name.
- **Why:** Keeps project directories clean, easy to discover, no nesting inside the repo.

### No persistent state
- The extension doesn't store any metadata between create and cleanup.
- Original repo path: derived from `git worktree list` (main worktree is always first).
- Merge target branch: specified as arg at cleanup time (defaults to `main`).
- **Why:** Git already tracks worktree relationships. Duplicating that state invites staleness.

### Create-or-resume semantics
- If a worktree already exists for the requested branch, the extension skips all git setup (no stash, no create) and just forks the session + switches to the existing worktree.
- Pending changes are only offered to bring along when creating a new worktree, not when resuming an existing one.
- **Why:** Stash-popping into an existing worktree with its own in-progress work risks conflicts. If the worktree exists, it already has its own state.

### Pending changes: stash staged + unstaged, ignore untracked
- `git stash push` captures staged and unstaged changes. Untracked files are left behind (they can't follow).
- User is asked whether to bring changes or leave them. Only asked when creating a new worktree (not resuming).
- **Why:** Treating staged and unstaged the same keeps it simple. Untracked files aren't part of the git state and can't be meaningfully stashed without `--include-untracked`, which adds complexity for little value.

## Direction

Two slash commands in a `worktree` extension:

**`/worktree create <branch-name> [base-branch]`**
1. Check if worktree already exists for that branch → if yes, fork session + switch, done.
2. If dirty working tree, ask user: bring changes or leave them?
3. Stash if bringing changes.
4. `git worktree add ~/.git-worktrees/<repo>/<branch> -b <branch> [base-branch]` (base defaults to current branch).
5. Pop stash in worktree if applicable.
6. Fork session to worktree path, switch to it.

**`/worktree cleanup [merge-target]`**
1. Send user message instructing agent to merge current branch into merge-target (default: `main`).
2. Wait for idle.
3. Check if working tree is clean — if not, return control to user with a message.
4. If clean: from main repo directory, `git worktree remove <path>`, `git branch -d <branch>`, then `newSession` in original repo.

Both commands support autocomplete on branch names.

## Open Questions

- **Branch deletion on cleanup:** Should `git branch -d` be automatic, or should the extension ask? Force-delete (`-D`) if not fully merged?
- **Multiple worktrees:** If you have several worktrees for the same repo, should `/worktree` offer a list/status view?
- **Worktree discovery:** Should `/worktree create` with no args list existing worktrees and offer to resume one?
