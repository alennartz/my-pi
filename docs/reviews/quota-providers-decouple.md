# Review: Quota providers decoupling

**Plan:** `docs/plans/quota-providers-decouple.md`
**Diff range:** `b71538cd1b9c405cd461825f0e9b24451f693c1d..9940a42c9c44def03b9fe217119c6e4a189b1da0`
**Date:** 2026-11-06

## Summary

The fixes isolate provider state per model registry and protect same-API registry refreshes. A refresh that changes the configured API still bypasses the quota guard, and the new wrapper state introduces three additional correctness risks around caller-controlled markers, provider replacement, and stale model catalogs.

## Prior findings verified

| Prior finding | Status |
|---|---|
| Registry refresh can leave one unguarded request | **Partially resolved** — same-API refreshes are guarded, but configured API changes still bypass the stable wrapper; see Finding 1. |
| Provider attachment state crosses independent runtimes | Resolved |

## Findings

### 1. API-changing refresh can still bypass quota

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/index.ts:297-313`
- **Status:** open
- **Fix:** Enforce quota before every transport dispatch, including the provider composer's API fallback.

The retained wrapper blocks a registry refresh that keeps the same API. When the refreshed provider changes its configured API, pi selects its API fallback instead of the wrapped stream. A targeted probe reached transport despite an enforced hard cap.

### 2. Caller-controlled marker can skip quota evaluation

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/lib/provider-wrapper.ts:20-71,142-150,198-207`
- **Status:** open
- **Fix:** Remove options-based guard suppression and track nested calls with unforgeable closed-over state.

The wrapper trusts `options[Symbol.for("my-pi.quota-provider-nested-guard")]`. Any caller or extension can set that global symbol to `true` and skip evaluation. The marker also remains on caller-owned options until the stream finishes, so a concurrent request that reuses those options can bypass its quota check.

### 3. Reattachment can discard a replacement provider

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/index.ts:297-313`
- **Status:** open
- **Fix:** Detect an external provider replacement and rebuild the attachment around the current provider.

Reattachment always reuses the previous wrapper as the native base. If another extension replaces the provider, quota registration restores the old provider instead, including its authentication configuration. The replacement provider is never used.

### 4. Removed models remain in the composed catalog

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts:297-310`
- **Status:** open
- **Fix:** Recompose from the current native catalog instead of retaining a previously composed catalog as the native base.

A `models.json` attachment captures its composed catalog as the permanent base. Later refreshes retain models removed from the current catalog. Replacing the sole model `removed` with `replacement` therefore leaves both models registered.

## Verification

Both resurrected verification passes completed. Their scoped checks passed 12 targeted tests; the full-baseline review was not repeated. No live harness was run because credentials and model prerequisites remain unavailable.
