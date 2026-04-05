# DR-028: Agent-Delegated Merge for Worktree Cleanup

## Status
Accepted

## Context
`/worktree cleanup` needs to merge the worktree branch into a target branch before removing the worktree and returning to the main repo. Merges can fail in unpredictable ways — conflicts, divergent histories, upstream changes — and conflict resolution strategies vary by situation. The extension must decide who handles the merge: its own code or the agent.

## Decision
Delegate the merge to the agent via `sendUserMessage` with a natural-language merge instruction, then `waitForIdle` until the agent finishes. The extension checks `git status --porcelain` afterward: if clean, it proceeds with worktree removal and branch deletion; if dirty, it notifies the user and returns control without cleanup, allowing the user to resolve and re-run `/worktree cleanup`.

Programmatic merge with conflict detection and resolution was rejected. Merge conflicts are unpredictable, and parsing `git merge` output to drive automated resolution is brittle — it would either fail on edge cases or require increasingly complex heuristics. The agent can handle conflicts naturally in conversation, applying judgment and asking the user when needed.

## Consequences
Cleanup is not a single atomic operation — the agent must run and the user may need to intervene on conflicts before cleanup completes. This is an acceptable trade-off: the merge is the one step that can go wrong in ways that require human judgment, and the agent is better positioned to handle that than hardcoded logic. The check-after-idle pattern keeps the extension simple — it doesn't need to understand merge output, only whether the result is clean.
