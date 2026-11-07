# Review: Quota providers decoupling

**Plan:** `docs/plans/quota-providers-decouple.md`
**Diff range:** `06cf2ffca5595b4da107d2881e749b78d9d850ae..b71538cd1b9c405cd461825f0e9b24451f693c1d`
**Date:** 2026-11-06

## Summary

The fixes resolve eight of the nine prior findings, including wrapper cleanup, locking, ownership, timestamp, and model-key issues. One registry-refresh path still allows a request through before its quota guard is installed, and the new process-global provider state can cross-contaminate independent runtimes.

## Prior findings verified

| Prior finding | Status |
|---|---|
| Registry refresh can bypass an attached quota | **Partially resolved** — the refresh hook is too late for the first request; see Finding 1. |
| Reloads can stack quota guards | Resolved |
| Shutdown leaves quota wrappers installed | Resolved |
| Ledger pruning writes after lock acquisition fails | Resolved |
| Quota policy remains in the provider catalog module | Resolved |
| Removed custom stream-guard files remain | Resolved |
| Provider requests can evaluate stale usage data | Resolved |
| DevPass timestamps usage after the catalog request | Resolved |
| Model-limit maps accept inherited object properties | Resolved |

## Findings

### 1. Registry refresh still leaves one unguarded request

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/index.ts:267-331,377-379`
- **Status:** resolved
- **Fix:** Reattach the wrapper during registry recomposition or guard a stable stream seam before the first request; do not rely on `before_provider_request`.

Lifecycle events now reattach guards, but `before_provider_request` runs during payload preparation after the unguarded stream method starts. If the registry refresh occurs during a turn, the first request with the replacement provider reaches transport despite an enforced hard cap.

### 2. Provider attachment state crosses independent runtimes

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/index.ts:183-200,247-248,298-331`
- **Status:** resolved
- **Fix:** Scope attachment state to its owning model registry or runtime with a `WeakMap`, then key provider entries within that scope.

The process-global provider-state map is keyed only by provider ID. Independent root and child registries can use the same ID, so one runtime overwrites another runtime's original or effective provider. A refresh or shutdown can then restore the wrong provider, including another runtime's authentication configuration.

## No Issues

The remaining prior findings were verified as resolved. The scoped quota and provider tests passed; the full-baseline review was not repeated. No live harness was run because credentials and model prerequisites remain unavailable.
