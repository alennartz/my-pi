# Review: Subagent CWD

**Plan:** `docs/plans/subagent-cwd.md`
**Diff range:** `e125e50..9f547af`
**Date:** 2026-05-16

## Summary

The implementation matches the plan and architecture cleanly. All 24 tests in `cwd.test.ts` and `persistence.test.ts` pass. Test files and interface declarations from the test-write commit are unchanged through implementation. No correctness issues surfaced — the diff is small, mechanical, and threaded through the documented seams.

## Findings

### Plan adherence

No significant deviations found.

- All 8 steps are reflected in the diff at the specified locations: `isValidCwd` and `resolveAgentCwds` in `agents.ts`; `pruneInvalidPersistedAgents` and the `cwd` round-trip in `persistence.ts`; `AgentEntry.cwd`, per-spec `RpcChild` cwd selection, `appendAgentAdded` plumbing, `toRestoreSpec` carry-over, and restore-time pruning in `agent-set.ts`; schema field, resolver call, and `agentSpecs` extension in `index.ts`.
- Test immutability holds — `git diff 8a262ca..HEAD -- extensions/subagents/cwd.test.ts extensions/subagents/persistence.test.ts` is empty.
- Error message format matches the contract tested in `cwd.test.ts` (includes both id and resolved absolute path).
- The fork/resurrect schemas are correctly left untouched — TypeBox `additionalProperties: false` (default) rejects unknown `cwd` fields with no explicit guard, as the architecture predicted.
- Batch atomicity is honored: `resolveAgentCwds` throws synchronously before any `RpcChild` is constructed in `index.ts`. Restore-time pruning is per-record (not batch), also matching the architecture.

### Code correctness

No issues found.

- `isValidCwd` correctly returns `false` on any thrown error (ENOENT, EACCES, EPERM, etc.) via the catch-all. Non-directory case handled by the `isDirectory()` check inside the try.
- `resolveAgentCwds` exits on first invalid entry — partial result is impossible because `result` is local and the throw exits the function.
- `agentSpecs.map` in `index.ts` builds each spec as `{ kind: "agent", ...a, model, cwd: resolvedCwds.get(a.id) }`. The explicit `cwd` override comes after `...a`, so a user-supplied relative `a.cwd` is correctly replaced by the resolved absolute path, and agents without a cwd get `cwd: undefined` which flows through to the `agentSpec.cwd ?? cwd` fallback at spawn time.
- `AgentEntry.cwd` stores the **unresolved override** (`agentSpec.cwd` only for `kind === "agent"`, else `undefined`), which is then written to `PersistedAgentRecord.cwd`. Because the tool handler always resolves to absolute before constructing specs, this is equivalent to storing the absolute path — and persisting `undefined` for "no override" preserves the legacy/default-cwd semantics on restore. Consistent with the architecture's "absent means use the parent default" contract.
- `pruneInvalidPersistedAgents` writes `agent_removed` events via `appendAgentRemoved` directly, before `this.persistence` is set on the manager. The function takes `paths` as a parameter, so this works correctly — no reliance on instance state.
- Restore double-write is correctly avoided: `appendAgentAdded` is gated by `!this.restoring` in `start()` (line 298), so survivors from `pruneInvalidPersistedAgents` are not re-logged.
- No race conditions, resource leaks, or unhandled error paths introduced. Filesystem checks are synchronous and bounded; no new async surface area.

## No Issues

Both passes ran clean. Plan adherence: implementation faithfully reflects all 8 planned steps with no observed drift. Code correctness: the new primitives are minimal, the plumbing through `agent-set.ts` and `index.ts` is mechanical, and the persistence round-trip is symmetric with the existing replay logic.
