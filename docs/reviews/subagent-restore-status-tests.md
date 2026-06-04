# Test Review: Subagent Status Recomputation on Session Resume

**Plan:** `docs/plans/subagent-restore-status.md`
**Brainstorm:** none (design settled through investigation conversation; intent sourced from the plan's Context + Architecture sections)
**Date:** 2026-06-03

## Summary

The tests for `parseSessionSnapshot` faithfully cover the documented behavioral contract and intent: degenerate inputs, malformed-line resilience, cumulative usage summing, last-assistant model/output capture, `lastTurnInput` derivation, and non-assistant noise filtering. They are at the right abstraction level (public function in, snapshot out), exercise only the materialized interface, and have no non-deterministic dependencies. Two findings were addressed: the `agent-set.ts` restore-seeding contract is intentionally left to its already-tested helpers, and a missing "unreadable file" degenerate case was added inline.

## Findings

### 1. Restore-seeding path in `agent-set.ts` has no dedicated test

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/agent-set.ts` (restore branch of `start()` / planned `childHasLiveSubagents`)
- **Status:** dismissed

The architecture's Interfaces section defines two contracts: `parseSessionSnapshot` and the `agent-set.ts` restore-seeding change (seed `state: "idle"`, snapshot-derived usage/model/lastOutput/lastTurnInput, `childHasLiveSubagents` for the subgroup flag). Only the pure function is tested. Dismissed with the user's concurrence: the architecture intentionally isolates the testable substance into `parseSessionSnapshot` plus the existing `loadPersistedAgents` (both already covered — the latter in `persistence.test.ts`). The restore-seeding path itself is field-copying/wiring behind real subprocess (`RpcChild`) and broker-socket machinery; a unit test there would assert mock plumbing rather than behavior. The plan's "recompute over replicate" guarantee is enforced by the helpers, not the wiring.

### 2. "Unreadable file" degenerate case was not covered

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `extensions/subagents/session-snapshot.test.ts:60-72`
- **Status:** resolved

The contract states "a missing, empty, or **unreadable** file yields a zeroed snapshot ... never throws." Tests covered the missing and empty cases but not unreadable. Added two tests that pass a directory path (`fs.readFileSync` on a directory throws `EISDIR`), asserting both the zeroed snapshot and the no-throw guarantee — completing all three degenerate inputs named in the contract. The plan's Behaviors-Covered list was updated to mention the unreadable case.

## No Issues

Beyond the two findings above, validation was clean. All brainstorm-equivalent intent (the plan's Context + Architecture) is covered by the snapshot tests. Tests sit at the component boundary (public `parseSessionSnapshot` only), import nothing beyond the interface, and have no timing/randomness/network/filesystem-ordering dependencies. Assertions are satisfiable by any correct implementation of the documented contract — no over-specification (e.g., float cost compared with `toBeCloseTo`, no internal-state or call-count assertions). All 20 tests currently fail with "not implemented" against the stub, as expected for the test-write phase.
