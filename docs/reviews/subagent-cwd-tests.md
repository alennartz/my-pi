# Test Review: Subagent CWD

**Plan:** `docs/plans/subagent-cwd.md`
**Brainstorm:** `docs/brainstorms/subagent-cwd.md`
**Date:** 2026-05-16

## Summary

The tests cleanly cover the brainstorm intent and architectural contract at the right abstraction level. Every key decision — `subagent`-only scope, per-agent cwd, relative-vs-absolute resolution, hard-fail validation, atomic-batch behavior, and persistence round-trip / restore-time pruning — is exercised against the materialized interfaces. No critical gaps, non-deterministic tests, or over-specified expectations.

## Findings

### No Issues

Validation turned up nothing actionable.

- **Brainstorm intent is covered.** Scope (subagent only — fork/resurrect excluded by simply not declaring `cwd` on their schemas, with TypeBox doing the rejection), per-agent placement (reflected in the `AgentCwdInput[]` signature on `resolveAgentCwds`), relative-path resolution against parent's cwd, absolute pass-through, and hard-fail validation are all exercised in `cwd.test.ts`. The persistence concerns the architecture added on top of the brainstorm (round-trip, legacy-line tolerance, restore-time pruning with `agent_removed` emission) are exercised in `persistence.test.ts`.
- **Tests are at component boundaries.** They hit the exported surface — `isValidCwd`, `resolveAgentCwds`, `appendAgentAdded` / `loadPersistedAgents` / `findAgentRecordBySessionId`, `pruneInvalidPersistedAgents` — without reaching into internals or asserting implementation details.
- **Path coverage is thorough.** Happy path, missing path, path-is-a-file, relative-input error messages referencing resolved absolute paths, atomicity (single invalid throws), and full-batch validation (a *later* invalid entry still throws) are all present. Persistence has cwd-present, cwd-absent, legacy-line, and `findAgentRecordBySessionId` cases. Pruning has keep-valid, keep-no-cwd-without-invoking-validator, drop-invalid, independent-failures, `agent_removed`-cancellation-on-reload, and empty input.
- **No non-deterministic tests.** All tests use a per-test `mkdtempSync` workspace cleaned in `afterEach`. No timing, randomness, network, or filesystem-ordering dependencies.
- **Expectations are appropriately loose.** Error-message assertions check for the offending agent's id and the resolved absolute path — they don't pin specific wording, formatting, or surrounding text. Result-map shape is asserted by key membership and value, not by ordering. Persistence assertions check observable round-trip semantics, not log-line structure.

Out-of-scope behaviors deliberately not unit-tested, consistent with the brainstorm's "small feature, mechanical glue" framing:

- Spawn-time selection `agentSpec.cwd ?? this.opts.cwd` in `AgentSet.start` (pure glue between tested components).
- The `subagent` tool handler's call into `resolveAgentCwds` (integration; the handler's atomicity falls out of the resolver's atomicity).
- Propagation (a child's own `subagent` calls defaulting to its cwd) — falls out of `ctx.cwd` plumbing in the child process; not a unit-testable boundary.
- Asymmetry (`agent: "scout"` resolved against the parent's project agents) — pre-existing behavior, untouched by this change.

These are appropriate to verify via manual testing once implementation lands rather than via additional unit coverage.
