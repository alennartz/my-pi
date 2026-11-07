# Review: Quota providers decoupling

**Plan:** `docs/plans/quota-providers-decouple.md`
**Diff range:** `dabfef3cfb7ed243143112d3919e5e5a546f3d7a..HEAD`
**Date:** 2026-11-06

## Summary

The implementation covers the planned split, and the approved tests remain unchanged. The full Vitest suite and the quota/provider suites pass, but provider attachment lifecycle bugs can bypass or retain quota enforcement, and the ledger lock failure can lose concurrent spend updates.

## Findings

### 1. Registry refresh can bypass an attached quota

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/index.ts:243,258-275`
- **Status:** open
- **Fix:** Track the effective-provider identity and reapply the wrapper whenever the model registry replaces that provider.

The attachment guard keys only on provider ID. A `models.json` provider replacement can therefore install a new effective provider without the quota wrapper. Subsequent streams skip the hard-cap check even though the attachment remains enabled.

### 2. Reloads can stack quota guards

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/lib/provider-wrapper.ts:18-32`; `extensions/quota-providers/index.ts:252-273`
- **Status:** open
- **Fix:** Use a stable wrapper marker and reuse or unwrap an existing guard before wrapping a recomposed provider.

The wrapper marker is a module-local `Symbol`, so a reload does not recognize a wrapper created by the previous module instance. The `models.json` recomposition path can also wrap an already wrapped provider. This stacks evaluators and can preserve stale quota policy across reloads.

### 3. Shutdown leaves quota wrappers installed

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/lib/provider-wrapper.ts:18-32`; `extensions/quota-providers/index.ts:291-302`
- **Status:** open
- **Fix:** Preserve each original provider and restore it when the attachment is disabled or the extension shuts down.

The lifecycle cleanup does not remove registered wrappers. A reload that disables hard-cap enforcement, or disables the attachment, can still execute the prior wrapper and block requests under the old policy.

### 4. Ledger pruning writes after lock acquisition fails

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/quota-providers/runner.mjs:198-219`
- **Status:** open
- **Fix:** Return from `pruneLedger` when the ledger lock was not acquired.

`pruneLedger` ignores the lock result and reads and rewrites the ledger after a timeout or acquisition error. A concurrent append can then be overwritten, losing local spend records and corrupting quota accounting.

### 5. Quota policy remains in the provider catalog module

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/llm-gateway/catalog.ts:3-5,82-93,239-260`; `extensions/quota-providers/impls/devpass-quota.ts:2,208`
- **Status:** open
- **Fix:** Move premium classification and limit mapping into the DevPass quota source, leaving the Gateway catalog to convert provider models.

The plan assigns premium thresholds and the `premium-weekly` model mapping to the quota source. `llm-gateway/catalog.ts` currently owns those rules and exports them to `devpass-quota.ts`, so the provider extension still contains quota policy and the intended ownership seam is not real.

### 6. Removed custom stream-guard files remain

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/stream-guard.ts:1-31`; `extensions/quota-providers/lib/stream-guard.test.ts:1-49`
- **Status:** open
- **Fix:** Delete the unused stream-guard module and its test.

Step 6 removes custom API streaming in favor of the complete-provider wrapper. These files still expose and test the obsolete stream-guard seam, although no active code imports them. Keeping them leaves a misleading implementation path for future changes.

### 7. Provider requests can evaluate stale usage data

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts:246-251`
- **Status:** open
- **Fix:** Refresh the attachment record with `maybeRefreshUsage` before evaluating each provider request.

The old stream guard refreshed usage before every request. The new evaluator only checks the cached record, while some trigger-turn and tool-loop requests do not emit the events that refresh it. Those requests can therefore use stale snapshots and miss a window reset or newly reached cap.

### 8. DevPass timestamps usage after the catalog request

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/impls/devpass-quota.ts:193-208`
- **Status:** open
- **Fix:** Capture the usage timestamp before fetching the catalog and use that timestamp for `asOf` and window bounds.

The source reads usage, then performs a second network request for the catalog, and assigns `asOf` afterward. A slow catalog request can advance snapshot authority, causing ledger pruning to delete spend absent from the earlier usage response or assign a renewal's spend to the wrong window.

### 9. Model-limit maps accept inherited object properties

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/quota-providers/index.ts:56-58,111,315`; `extensions/llm-gateway/catalog.ts:243-256`
- **Status:** open
- **Fix:** Build null-prototype membership maps and require own-property checks during lookup.

Membership lookup reads inherited properties. A model named `constructor` can make `limitIds.includes` fail, while `__proto__` can mutate the map prototype instead of becoming a serialized model entry. Model IDs are external catalog data, so these names must remain ordinary unmapped or mapped keys.

## No Issues

Plan adherence found no test-file immutability violations. The full Vitest suite passed, and the live harnesses remain unrun because credentials and model prerequisites were unavailable as recorded in the plan.
