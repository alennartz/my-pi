# Review: Quota providers decoupling

**Plan:** `docs/plans/quota-providers-decouple.md`
**Diff range:** `9940a42c9c44def03b9fe217119c6e4a189b1da0..c502974f8e2f58f6d71439375193f1515273ab75`
**Date:** 2026-11-06

## Summary

The fix diff resolves prior findings 2–4 for the supported provider cases. It removes the caller-controlled nested marker, adopts provider replacements during reattachment, and rebuilds `models.json` attachments from refreshed catalogs. Three regressions remain in evaluator replacement and refresh ordering for the current DevPass provider.

## Prior findings verified

| Prior finding | Status |
|---|---|
| Caller-controlled marker can skip quota evaluation | Resolved |
| Reattachment can discard a replacement provider | Resolved at reattachment |
| Removed models remain in the composed catalog | Resolved for supported `models.json` cases |

## Scope verified

The supported scope covers quota enforcement for:

- Pi built-in providers.
- `models.json` models using Pi-supported APIs.
- The current DevPass provider.

A third-party extension replacing the same provider ID mid-session before quota reattachment is explicitly out of scope. The plan documents this limit and does not claim that case is technically fixed.

## Findings

### 1. Rewrapping keeps a stale evaluator

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/provider-wrapper.ts:97-108,128-136,170-179`
- **Status:** open
- **Fix:** Read the current evaluator from the stable wrapper state for every guarded stream.

`guardedStream` captures the evaluator that existed when the wrapper was created. Updating `state.evaluate` no longer changes the guard's behavior. Rewrapping an allowed provider with a blocking evaluator therefore still executes transport.

### 2. A successful DevPass refresh temporarily removes its catalog

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts:310-327,339-341`
- **Status:** open
- **Fix:** Preserve the refreshed dynamic state or await catalog restoration before the refresh hook resolves.

The refresh hook recreates the legacy DevPass registration and returns before asynchronous catalog restoration completes. An awaited successful refresh of the current LLM Gateway provider therefore returns an empty catalog, with refreshed models appearing only later.

### 3. An older refresh can cancel a newer refresh

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts:321-327,337-342`
- **Status:** open
- **Fix:** Let only the latest refresh generation detach and rebuild attachments.

Every refresh completion detaches providers. When forced refreshes overlap, an older completion aborts the newer request. Two overlapping DevPass refreshes can therefore both abort without reporting an error.

## Verification

Both resurrected verification passes completed. Their targeted follow-up tests passed, and approved test files remain unchanged. The full-baseline review was not repeated. No live harness was run because credentials and model prerequisites remain unavailable.
