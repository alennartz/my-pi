# DR-027: Session Replacement for Worktree Transitions

## Status
Accepted

## Context
The worktree extension needs to move the agent's working context between the main repo and worktree directories. pi's tools capture cwd at session creation time — there's no `setCwd` API to rebind them in-place. Moving the agent to a different directory requires a mechanism that rebuilds the cwd-bound runtime state (tool discovery, resource loading, session plumbing) for the target location.

## Decision
Model worktree moves as session replacement: create a new session in the target cwd (`SessionManager.create` for fresh starts, `SessionManager.forkFrom` for context preservation), then `ctx.switchSession()` to activate it with rebuilt runtime state. Fork is an optional continuity mechanism offered to the user when creating a new worktree ("bring context" vs. "fresh session"); cleanup always returns to the main repo via a fresh session since the worktree conversation is complete.

In-place cwd mutation was rejected because pi's runtime binds tools to the session's cwd at creation time — changing directory without replacing the session would leave tools, resource discovery, and session plumbing pointed at the wrong location.

## Consequences
Each worktree transition creates a new session file. Cleanup intentionally discards worktree conversation history rather than carrying it back — worktree work is isolated by design. If pi later adds runtime cwd rebinding, this decision could be revisited, but session replacement remains the safer model since it guarantees all cwd-dependent state is reconstructed.
