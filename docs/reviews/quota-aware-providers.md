# Review: Quota-Aware Providers

**Plan:** `docs/plans/quota-aware-providers.md`
**Diff range:** `413e901d216017cb22b58c7351914cc859f16e0b..bffe3f9f6333bf119b8a7a6ff4fc203ad8ff29b0`
**Date:** 2026-07-14

## Summary

The implementation is substantially complete and faithful to the plan — all 16 steps are addressed (Step 16 intentionally deferred to cleanup). Two critical correctness issues stand out: the usage lock is leaked on every error or stampede-guard exit inside `cmdUsage`, and bypass staleness is never evaluated at enforcement time, so a bypass enabled during one billing window silently disables soft-cap enforcement in perpetuity. Several warnings follow around the ledger-prune race, unvalidated seam output, and a `let`-captured module-level record that violates the coding principles. Plan deviations are minor.

## Findings

### 1. Usage lock leaked on process.exit() inside try — poll cadence permanently degraded on errors

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/runner.mjs:314–371`
- **Status:** resolved

`process.exit()` does not run `finally` blocks. Two paths inside `cmdUsage`'s `try` call `process.exit` while holding the lock: the stampede-guard freshness re-check (`process.exit(0)` ~line 322) and `fail()` (~line 335, which also calls `process.exit(1)`) when `getUsage` throws. The lock file (`usage.json.lock`) is never released, blocking all subsequent usage refreshes until the 60 s `LOCK_STALE_MS` steal threshold. With `maxPollSeconds < 60` this permanently throttles usage polling to at-best-every-60 s cadence. The stampede-guard path fires on every concurrent second refresh (i.e., normal operation under multiple pi processes), so the leak is not an edge case.

Fix: replace the in-`try` `process.exit(0)` with a `return`-based flow that reaches the `finally`, and release the lock before the `fail()` call (or move lock release into an explicit pre-exit helper shared by all paths).

---

### 2. Bypass staleness never checked at enforcement time — bypass is permanent across window resets

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/index.ts` (input handler ~line 330–334; statusline ~line 113–115)
- **Status:** resolved

`pruneBypass` is called only inside the `/quota bypass` toggle handler. Enforcement and statusline both call `isBypassActive(readBypass(...), scope)` with no staleness filter. The plan states: "Entries are pruned when stale (older than the quota window)." A scope that enables bypass once stays bypassed across billing window resets, indefinitely — soft-cap enforcement is silently disabled for the lifetime of the session (or longer if `PI_QUOTA_SCOPE` persists in the environment).

Fix: apply `pruneBypass` (or an equivalent `enabledAt >= windowStart` check) at read time in both the input handler and the statusline helper, using the current snapshot's window boundary.

---

### 3. Unvalidated snapshot written by cmdUsage creates a permanently "fresh but useless" cache

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/runner.mjs:331–339`; `extensions/quota-providers/index.ts` (`maybeRefreshUsage` ~line 278–295)
- **Status:** resolved

`cmdDiscover` validates its result is an array; `cmdUsage` writes whatever `getUsage` returns without validating shape. A malformed snapshot produces a file with a valid `writtenAt` (so the runner's stampede guard says "fresh") that `readUsageSnapshot` then rejects (returning `null`). Enforcement is silently off for that provider. The extension side, seeing `null` → age `Infinity`, spawns a detached `usage` runner on every prompt and `message_end`, each of which grabs the lock, concludes the cache is fresh, and exits — amplifying the F1 lock leak. Validate `spend`, `quota`, `windowStart`, `windowEnd`, `asOf` are present and numeric in the runner before writing; call `fail()` on garbage.

---

### 4. Ledger prune races with concurrent appendLedgerEntry, silently dropping cost entries

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/runner.mjs:342–361`; `extensions/quota-providers/lib/ledger.ts` (`appendLedgerEntry`)
- **Status:** resolved

The prune is read → filter → `writeAtomic` (temp + rename). Any pi process that appends a ledger entry (via `appendFileSync`) between the runner's `readFileSync` and its `renameSync` has its append clobbered. Lost entries mean undercounted spend — the wrong bias per the plan ("overcounting blocks early … early is the right bias"). The window is small but the append fires on every assistant message across all pi processes; the prune fires on every usage refresh, so this will occur in production over time.

Mitigation: perform the prune only while holding the usage lock (already acquired by `cmdUsage`) so appenders must wait; alternatively, document the known loss and accept it since entries after `asOf` are the only safety-critical ones and those are always newer than the refresh.

---

### 5. Any pre-agent_start error notify permanently marks a live child as failed

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agent-set.ts:726–742`
- **Status:** dismissed

The trigger already keys on `notifyType === "error"` — warning-level notifies never fail a child, which is the primary case the finding worried about. The residual concern (a non-fatal error-level notify before `agent_start`) is rare enough that added recovery machinery is not warranted.

The `settleFailed` branch fires on any `notify(..., "error")` before `agent_start` — not just quota-blocked prompts. An extension that emits a non-blocking error notify at startup (config warning, transient failure) while still letting the prompt proceed causes: `settleFailed` → `state = "failed"` → the subsequent real `agent_start` is ignored (guard: `state !== "failed"`) → the child runs to completion but the parent has already reported it failed and dropped it from the broker. The output is lost. This is an accepted tradeoff when the notify is from a blocked prompt, but any false positive is unrecoverable. Consider letting `agent_start` recover an entry settled via the notify path (vs. a process crash), or narrowing the trigger to notifies received within a short grace window before `agent_start` arrives.

---

### 6. refreshTokenSync destructures a possibly-null seam result

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/runner.mjs:131–140`
- **Status:** resolved

If `impl.getToken` resolves to `null`/`undefined` rather than throwing, `const { token, expiresAt } = result` throws a TypeError outside any `catch` → unhandled top-level rejection with a raw Node stack trace, and — for `cmdToken` — no stale-token fallback even when a prior cached token exists. Add a null-guard on `result` before destructuring, routing to the same `fail()`/fallback path as a thrown error.

---

### 7. readModelsCache does not validate writtenAt — background discovery refresh permanently suppressed on corrupt cache

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/registration.ts:148–160`
- **Status:** resolved

Only the `models` field is validated. A cache with a missing or non-numeric `writtenAt` yields `discoveryRefreshDue(undefined, now, …)` → `NaN > REFRESH_*` → always `false` → background refresh never fires and the stale model list persists until the file is deleted by hand. Add a `typeof parsed.writtenAt === "number"` check; return `null` (treat as cache miss) if missing.

---

### 8. /quota bypass bare toggle with multiple providers produces inconsistent state

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts` (`/quota bypass` handler ~line 380–410)
- **Status:** resolved

`shouldEnable = !currentlyActive` is computed per record. With two providers where one has bypass active and the other doesn't, a bare `/quota bypass` flips them to opposite states. The final notify reflects only the last provider's `newState`. Compute the toggle target once (e.g., `!anyActive`) and apply it uniformly across all records in the same write.

---

### 9. cachePaths.usageLock is dead code with a filename mismatch

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/config.ts` (`cachePaths`); `extensions/quota-providers/runner.mjs:285`
- **Status:** resolved

Plan Step 3 specifies `cachePaths` returns `usageLock` at `<dir>/usage.lock`. Plan Step 6 specifies the runner acquires a lock at `--cache path + ".lock"`, which when `--cache` is `usage.json` produces `usage.json.lock`. The runner correctly follows Step 6. The `usageLock` field in `CachePaths` points to `usage.lock`, is never passed to the runner, and is never used in `index.ts` — it is dead code with a wrong filename. The two plan steps contradict each other; the dead `usageLock` field is the orphan.

---

### 10. providerRecords declared as a reassignable let captured by event-handler closures

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts` (module-level `export let providerRecords`)
- **Status:** resolved

Plan Step 9 specifies: "Keep a module-level **immutable array** … this is init-then-freeze config state." Coding Principle #4: "The outer slot a closure captures from must not be reassignable after the closure is created."

`providerRecords` is declared `export let` and reassigned inside the factory (`providerRecords = Object.freeze(records)`), after which event handlers close over the `let` slot. The sequencing is correct (assign-then-register), so it works in practice. But the slot remains reassignable and exported as such, violating both the plan's "immutable array" intent and the coding principle. Declare a `const` local alias (`const records = Object.freeze(…)`) and pass it into handlers rather than closing over the module-level `let`, or eliminate the `let` export entirely and pass records as parameters.

---

### 11. Footer suffix priority inversion — hard-exceeded provider shows "bypassed" if bypass entry exists

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/quota-providers/index.ts` (statusline suffix logic ~line 100–115)
- **Status:** resolved

The plan states "Hard cap is never bypassable" and implies `(HARD CAP)` takes precedence in the footer. The implementation checks `bypassActive` first, so a hard-exceeded provider with a stale or ineffectual bypass scope entry shows `(bypassed)` rather than `(HARD CAP)`. Check `hard-exceeded` state before `bypassActive` when composing the suffix.

---

### 12. /quota status omits raw daysAhead value

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/quota-providers/index.ts` (`/quota` command handler)
- **Status:** resolved

Plan Step 12: "render … `daysAhead` (both raw and "spending at <date>'s budget")." Only the human-readable form is rendered; the raw numeric value (e.g., `+5.3 days`) is absent.

---

### 13. /quota status omits "whether the impl has the usage seam" per provider

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/quota-providers/index.ts` (`/quota` command handler)
- **Status:** resolved

Plan Step 12: "whether the impl has the usage seam." The handler silently omits providers without `getUsage`. The plan intends each provider to appear with a seam-present indicator; a missing implementation should not disappear from the status output entirely.

---

### 14. settleFailed does not reset agentStartedSinceLastPrompt

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/agent-set.ts` (`settleFailed` ~line 761)
- **Status:** resolved

The idle path resets `agentStartedSinceLastPrompt`. The failed path does not. Today this is masked because a failed entry can never return to `running`. If failed-entry re-prompting is ever allowed, a blocked re-prompt silently passes through the notify-settle guard (flag stuck `true`) and the parent hangs. Reset the flag inside `settleFailed` for symmetry and forward safety.

---

### 15. shell-quoting in apiKey command breaks on paths containing $, backticks, or embedded quotes

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/quota-providers/index.ts` (~line 232, apiKey command string construction)
- **Status:** resolved

The command string uses double quotes around path interpolations. `/bin/sh -c` does not suppress `$`, backticks, or embedded `"` inside double quotes. A path like `~/providers/$USER/impl.ts` would be shell-expanded. Not a security boundary (config is user-owned), but token fetch fails confusingly on such paths. Use single-quote escaping for path components.

---

### 16. Cold-miss discovery failure discards runner stderr

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/quota-providers/index.ts` (~line 191–208, `execFileSync` call)
- **Status:** resolved

`execFileSync(..., { stdio: "ignore" })` discards the runner's `fail()` message. The warning shows only Node's generic "Command failed". Diagnosing a broken impl requires re-running the command manually. Capture stderr and include it in the warning.

## No Issues

Code correctness pass found no issues with: quota math boundary/degenerate handling; lock-steal logic for vanished-lock and lost-steal races; `parseBypass`/`parseLedger` garbage tolerance; `groupModels` suffixing; `agentStartedSinceLastPrompt` reset-on-idle for the normal idle→prompt→agent_start cycle; exact-match `providerIdToRecord` lookup (stronger than plan's prefix-match spec); hard-cap-never-bypassable in `decideBlock`.

Plan adherence pass found no issues with: overall architectural fidelity (types, runner, registration, enforcement, command, statusline, ledger/bypass stores); jiti dependency; fake implementation fixture; runner integration tests.
