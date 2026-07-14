# Review: Quota-Aware Providers

**Plan:** `docs/plans/quota-aware-providers.md`
**Diff range:** `413e901d216017cb22b58c7351914cc859f16e0b..a8fea84b1b67879a2c36a949a21125590338c8d2`
**Date:** 2026-07-14

## Summary

This is a re-review scoped to the fix commits (`bffe3f9..4204e0a`). Thirteen of the original fourteen findings are resolved. One prior warning stands — the design tradeoff around pre-`agent_start` error notifies settling live children as permanently failed. One new warning is introduced by the ledger-lock fix: `acquireLockSync` busy-spins synchronously on pi's main event-loop thread while the runner holds the usage lock across the entire `getUsage` call (not just the prune step as the comment implies), so a slow usage API can freeze pi for up to 10 seconds.

## Findings

### 1. acquireLockSync busy-spins on main thread while runner holds lock across getUsage

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/ledger.ts:27–67` (acquireLockSync); `extensions/quota-providers/runner.mjs:258–395` (cmdUsage lock scope)
- **Status:** open

The comment in `acquireLockSync` says "the prune holds it for < a few ms, so contention is brief." This was true of the original design where the lock guarded only the prune step. After the fix, `cmdUsage` holds the lock from `tryAcquireLock()` through the entire `try` block — which includes `await impl.getUsage(ctx)`, a network call that may take several seconds. `appendLedgerEntry` is called from the `message_end` event handler on the main thread, so if a usage runner happens to be mid-`getUsage` when a message completes, the main event loop will busy-spin (synchronously, no `setImmediate` or I/O yield) for however long `getUsage` takes — up to the 10-second deadline. This freezes the TUI and blocks all other event processing in that pi process.

Fix options: hold the lock only during the prune (drop it before `getUsage`, re-acquire for the read→filter→rename), or release the lock in `cmdUsage` before calling `getUsage` and re-acquire for the prune — since the stampede guard is already a separate freshness re-check inside the lock. Either narrows the critical section to the brief prune step where the "< a few ms" claim actually holds.

---

### 2. Any pre-agent_start error notify permanently marks a live child as failed

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agent-set.ts:726–742`
- **Status:** open

Unchanged from the prior review. The `settleFailed` branch fires on any `notify(..., "error")` before `agent_start` — not only quota-blocked prompts. An extension in the child that emits a non-blocking error notify at startup (config warning, transient failure) while still letting the prompt proceed will cause: `settleFailed` → `state = "failed"` → the subsequent real `agent_start` is ignored (guard: `state !== "failed"`) → the child runs to completion but the parent has already reported it failed and dropped it from the broker. The child's output is lost. Every false positive is unrecoverable. Consider letting `agent_start` recover an entry settled via the notify path (as opposed to a process crash), or narrowing the trigger to notifies received with no subsequent `agent_start` within a short grace window.

---

## Resolved Findings

All fourteen findings from the original review are listed here with disposition.

**Finding 1 — Usage lock leaked on process.exit() inside try:** Resolved. Both `process.exit(0)` calls inside the `try` replaced with `return` (so `finally` fires); a `releaseLock()` helper is extracted and called before each `fail()` for symmetry. The `finally` block's `releaseLock()` is idempotent.

**Finding 2 — Bypass staleness never checked at enforcement time:** Resolved. Both the input handler and `refreshStatusline` now call `pruneBypass(rawBypass, now, windowLengthMs)` before `isBypassActive`, using the current snapshot's window length.

**Finding 3 — Unvalidated snapshot written by cmdUsage:** Resolved. The runner validates that `spend`, `quota`, `windowStart`, `windowEnd`, and `asOf` are all numeric before writing; calls `releaseLock()` then `fail()` on malformed output.

**Finding 4 — Ledger prune races with concurrent appendLedgerEntry:** Resolved structurally. `appendLedgerEntry` now accepts an optional `usageLockPath` and acquires the usage lock before appending; callers in `index.ts` pass `${record.paths.usage}.lock`. (See Finding 1 above for a new concern introduced by this fix.)

**Finding 5 — Any pre-agent_start error notify permanently marks a live child:** Not resolved — carried forward as Finding 2 above.

**Finding 6 — refreshTokenSync destructures possibly-null seam result:** Resolved. A null-guard is inserted before destructuring; null/undefined routes to the stale-token fallback or `fail()`.

**Finding 7 — readModelsCache does not validate writtenAt:** Resolved. The cache is accepted only when `typeof parsed.writtenAt === "number"` in addition to `Array.isArray(parsed?.models)`.

**Finding 8 — /quota bypass bare toggle inconsistent across providers:** Resolved. A single `toggleTarget` is computed once from `anyActive` across all providers and applied uniformly in the per-record loop.

**Finding 9 — cachePaths.usageLock dead code with filename mismatch:** Resolved. The `usageLock` field is removed from `CachePaths` and its test assertion dropped.

**Finding 10 — providerRecords declared as reassignable let captured by closures:** Resolved. The module-level `export let providerRecords` is removed; handlers close over a `const providerRecords` local in the factory after `Object.freeze`.

**Finding 11 — Footer suffix priority inversion (hard-exceeded shows "bypassed"):** Resolved. The suffix check now tests `hard-exceeded` before `bypassActive`.

**Finding 12 — /quota status omits raw daysAhead value:** Resolved. The Pace line now shows both the human-readable form and the raw `+N.N days` / `−N.N days` value in parentheses.

**Finding 13 — /quota status omits "whether impl has usage seam" per provider:** Resolved. The status command now iterates all `providerRecords` (not just those with a usage seam), shows a `Usage seam: yes/no` line for every provider, and skips the spend/quota block for providers without `getUsage`.

**Finding 14 — settleFailed does not reset agentStartedSinceLastPrompt:** Resolved. `entry.agentStartedSinceLastPrompt = false` added inside `settleFailed`.

## No Issues

Plan adherence re-check: no new deviations introduced by the fix commits. The apiKey command now uses single-quote escaping (`sq()` helper) — correct for `/bin/sh -c`, handles `$`, backticks, and embedded double quotes in paths. The cold-miss discovery path now captures runner stderr and includes it in the warning. All structural fixes follow the existing module boundaries.
