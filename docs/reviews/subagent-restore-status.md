# Review: Subagent Status Recomputation on Session Resume

**Plan:** `docs/plans/subagent-restore-status.md`
**Diff range:** `ac24d03f801fdec0abdd699a7f08b711794150c5..HEAD`
**Date:** 2026-06-03

## Summary

The plan was implemented faithfully and completely. The new `session-snapshot.ts`
parser matches its documented behavioral contract, and the `agent-set.ts` restore
path was branched exactly as the architecture sketched — recomputing faithful
status from the child's own session file with an `idle` seed, while leaving the
fresh-spawn path untouched. All 20 snapshot tests pass, and the test files are
byte-identical between `pre-implementation-commit` and HEAD (immutability holds).
No correctness risks were found.

## Findings

_No findings._

## No Issues

**Plan adherence: no significant deviations found.**

- **Step 1** (`parseSessionSnapshot`) implemented per contract: `try/catch` read
  yields a zeroed snapshot on missing/unreadable/directory paths; lines are split
  on `\n` with empty lines skipped; the `"role":"assistant"` compact-JSON substring
  pre-filter rejects non-assistant lines before parsing; per-line `JSON.parse` is
  wrapped in `try/catch`; shape is re-confirmed (`type === "message"` &&
  `message.role === "assistant"`) after the fast reject; cumulative usage sums with
  `?? 0` defaults; `model`/`lastOutput`/`lastTurnInput` track the last assistant
  message in file order, with `lastOutput` preserved when the last message has no
  text part. Verified against the real pi session format — actual session JSONL is
  compact (`"role":"assistant"`, 0 spaced occurrences), so the substring pre-filter
  is sound, not just a test-fixture artifact.
- **Step 2** (`childHasLiveSubagents` + restore seeding) implemented per contract:
  the `parseSessionSnapshot` import was added; the helper delegates to the existing
  `loadPersistedAgents` and returns `loaded !== null && loaded.agents.length > 0`;
  the `start()` status seed branches on `this.restoring && agentSpec.resumeSessionFile`,
  building an `idle` snapshot-derived status with every required `AgentStatus` field
  present (identity fields factored into a shared `identity` object). The
  fresh-spawn path is unchanged (`running`, zeroed usage, `hasSubgroup: false`).
  No new fields were added to `PersistedAgentRecord` — recompute-over-replicate is
  honored. Event-driven transitions in `handleRpcEvent` and `appendAgentAdded`
  gating were not touched.
- **Test immutability: confirmed.** `git diff a3edd78..HEAD -- session-snapshot.test.ts`
  is empty — the test file written in the test-write phase was not modified during
  implementation.

**Code correctness: no issues found.** Degenerate inputs are handled without
throwing, malformed lines are skipped individually, and a user/toolResult message
whose text happens to contain the substring would still be rejected by the
post-parse shape check (no false positives). The redundant `snapshot.model =
undefined` reset on a model-less last assistant message is intentional and matches
the documented contract (model reflects the *last* assistant message regardless of
prior values) — not a defect.
