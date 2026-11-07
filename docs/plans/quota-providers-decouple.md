# Plan: Quota providers decoupling

## Context

Separate dynamic model provisioning from quota enforcement so quotas can attach to any configured pi provider. The user-approved direction and trade-offs are in [the brainstorm](../brainstorms/quota-providers-decouple.md).

## Architecture

### Impacted Modules

- **Quota Providers** — `extensions/quota-providers/**` becomes a quota-only extension. Its config names actual pi provider IDs. It owns usage polling, snapshot and ledger storage, caps, bypass, `/quota`, footer status, and the blocking stream wrapper. Remove model discovery, token management, provider grouping, and provider registration from this module. Keep the out-of-band runner only for usage-source execution, atomic usage-cache writes, locking, and ledger pruning.
- **Quota Provider Implementations** — replace the combined DevPass implementation with a quota-source adapter. It reports the provider-wide monthly snapshot using `billingCycleAnchor`, plus a separate `premium-weekly` snapshot when that pool exists. It maps premium model IDs using the existing pricing rule: at least $5/M input or $15/M output, using catalog prices or eligible-provider medians. The generic core sees only snapshots, opaque `limitId` strings, and model mappings. Remove Foundry's implementation. Move model catalog conversion into the new LLM Gateway provider extension. Remove DevPass's encrypted-content retry rewrite; this error will use pi's normal retry classification.
- **Subagents** — keep the existing tree-scoped bypass interface. Each child runtime loads its own quota wrapper and resolves bypass through the shared agent-tree store. DR-045 remains in force.
- **My-pi Documentation** — describe the provider extension and quota-only configuration separately. Document the `devpass-openai-completions` to `llmgateway` provider-ID migration and remove Foundry setup instructions.

### New Modules

- **LLM Gateway Provider** — a normal pi extension under `extensions/llm-gateway/`. It registers provider ID `llmgateway`, displays the LLM Gateway DevPass name, fetches `/v1/models`, and maps supported models to pi metadata. It uses the `openai-completions` API, `LLMGATEWAY_API_KEY`, and pi's built-in streaming implementation. It owns no quota policy or usage polling.

### Interfaces

**Provider registration.** Register the LLM Gateway using `ProviderConfig.refreshModels`:

```ts
pi.registerProvider("llmgateway", {
  name: "LLM Gateway DevPass",
  baseUrl: "https://api.llmgateway.io/v1",
  api: "openai-completions",
  apiKey: "$LLMGATEWAY_API_KEY",
  authHeader: true,
  refreshModels: async (context) => ProviderModelConfig[],
});
```

The refresh handler honors `context.signal`, `context.allowNetwork`, and pi's provider-cache contract. Persist refreshed models through pi's provider-refresh mechanism as full `AnyModel` records in a `ModelsStoreEntry`, including provider and base URL. Return provider model configurations from the refresh handler, and convert stored records back to that form when restoring. Reuse `context.stored` when its `checkedAt` timestamp is less than one hour old and the refresh is not forced; refresh older or forced catalogs. Offline runtimes restore stored models without network access. This avoids normal parent-to-subagent duplicate fetches. Concurrent cold starts can still fetch the catalog more than once; no cross-process refresh lock is added. Do not supply a custom stream implementation. The old provider ID is intentionally replaced; existing session and `models.json` references need migration.

**Quota attachment configuration.** Keep `~/.pi/agent/quota-providers.json` as the sole quota configuration file. Its `providers` object is keyed by actual pi provider ID. Each enabled attachment requires a usage-source module and carries the existing quota policy fields. Module-specific settings pass through to the source. The DevPass entry is keyed by `llmgateway`.

**Quota source result.** Preserve the existing `UsageSnapshot.limitId` name and treat its value as opaque. The generic core never recognizes names such as `premium` or periods such as `weekly`.

```ts
interface QuotaSource {
  getUsage(context: ImplContext): Promise<{
    snapshots: UsageSnapshot[];
    modelLimitIds: Record<string, string[]>;
  }>;
}
```

`UsageSnapshot` keeps its current fields: optional `limitId` and `label`, `spend`, `quota`, `windowStart`, `windowEnd`, and `asOf`. A snapshot without `limitId` applies to every model. A snapshot with `limitId` applies only to models whose IDs map to it. Each snapshot is an independently evaluated budget with its own window; the core has no parent/subbudget hierarchy. DevPass uses one unscoped monthly snapshot and a separately reset `premium-weekly` snapshot scoped to premium models. The quota source owns that mapping and returns it with usage. The quota runner writes snapshots and `modelLimitIds` together to one cache file. The local ledger keeps its current behavior and records limit IDs from that cached model map.

**Provider blocking seam.** Use the effective provider from `ctx.modelRegistry.getProvider(providerId)`, wrap its `streamSimple`, and register the complete wrapped provider with `pi.registerProvider(provider)`. The wrapper evaluates the quota before calling the original stream. It delegates every other provider field and method unchanged, including auth, filtering, model listing, refresh, and API transport. It must be idempotent within one provider runtime so reloads do not stack quota guards. At the extension lifecycle boundary, resolve attachments against the session's effective model registry and install complete wrapped providers. Leave unattached providers unchanged. Quota decisions and ledger entries use model membership from the same cached usage record; bypass follows the requesting session's tree.

**Attachment boundary.** The guarantee covers Pi built-in providers, `models.json` providers using Pi-supported APIs, and the current DevPass provider registration. A third-party extension that re-registers the same provider ID during a running session, before quota reattachment, is outside the guarantee because the existing extension APIs provide no pre-dispatch hook for that replacement.

Do not register a partial `{ streamSimple }` overlay over a complete native provider: pi removes the native registration when it accepts a legacy provider config. `before_provider_request` cannot block because the extension runner catches handler errors and continues with the request. A quota block remains a non-retryable stream error before the transport call, preserving DR-057 behavior.

### Technology Choices

- **Use `ProviderConfig.refreshModels` for LLM Gateway.** A complete `Provider` offers more control over native auth, filtering, and provider lifecycle, but this integration needs an env-backed API key, one supported API, and a dynamic model list. `ProviderConfig.refreshModels` needs less code and delegates streaming and refresh behavior to pi. Static `models.json` cannot discover the live catalog.
- **Use pi's persisted provider catalog instead of the quota runner's model cache.** `refreshModels` uses pi's cancellation, refresh, and `models-store.json` persistence. The provider extension reuses the stored catalog for one hour unless refresh is forced; it restores stored models offline. This avoids ordinary parent-to-subagent duplicate requests without a custom cache or cross-process lock. Remove the quota extension's model and token caches and background model-discovery process. Keep the usage snapshot and local ledger caches because they serve quota enforcement and cross-machine coordination.
- **Wrap complete providers instead of using a partial legacy overlay or changing pi.** The full-provider wrapper preserves the selected provider's existing behavior across built-in, `models.json`, legacy extension, and native extension registrations. A pi-level blocking middleware hook would be more direct but requires a host change; a partial `ProviderConfig` overlay does not preserve complete native providers.

### DR Supersessions

None. DR-045's tree-scoped bypass and DR-057's provider-stream blocking behavior remain in force. DR-043's jiti loading remains for TypeScript quota-source modules.

## Tests

**Pre-test-write commit:** `dabfef3cfb7ed243143112d3919e5e5a546f3d7a`

### Interface Files

- `extensions/quota-providers/index.ts` — extension lifecycle and effective-provider registry attachment seam.
- `extensions/quota-providers/lib/types.ts` — quota-source result and source contracts.
- `extensions/quota-providers/lib/attachments.ts` — quota attachment configuration types and parser seam.
- `extensions/quota-providers/lib/provider-wrapper.ts` — complete-provider quota wrapper seam.
- `extensions/quota-providers/lib/usage-cache.ts` — atomic usage snapshot and model-limit cache shape.
- `extensions/quota-providers/impls/devpass-quota.ts` — DevPass quota-source adapter contract.
- `extensions/llm-gateway/index.ts` — LLM Gateway provider extension registration seam.
- `extensions/llm-gateway/package.json` — extension manifest for the provider integration.

### Test Files

- `extensions/quota-providers/attachment.integration.test.ts` — effective-provider registration, scoped decisions, ledger membership, and tree bypass.
- `extensions/quota-providers/lib/attachments.test.ts` — provider-ID keyed configuration and settings passthrough.
- `extensions/quota-providers/lib/provider-wrapper.test.ts` — blocking and complete-provider preservation across provider origins.
- `extensions/quota-providers/lib/usage-cache.test.ts` — atomic snapshot and model-limit map parsing.
- `extensions/quota-providers/impls/devpass-quota.test.ts` — DevPass monthly and premium-weekly source behavior and premium model mapping.
- `extensions/quota-providers/runner-usage.test.ts` — runner persistence of snapshots with model-limit membership.
- `extensions/quota-providers/test/fake-quota-source.ts` — deterministic quota-source fixture for runner tests.
- `extensions/llm-gateway/index.test.ts` — provider registration, refresh caching, offline restore, forced refresh, and model mapping.

### Behaviors Covered

#### Quota attachment configuration

- A quota attachment targets an existing pi provider ID and carries quota-source configuration only.
- Policy fields resolve independently from module-specific settings, which pass through unchanged.
- Disabled and malformed attachments resolve predictably with warnings.

#### Provider blocking wrapper

- A quota decision blocks every provider stream before transport execution, including built-in, `models.json`, legacy extension, and native extension providers.
- The wrapper preserves provider identity, authentication, model listing, refresh, filtering, streaming, deferred, image, and classifier operations.
- The extension attaches through the effective registry for each provider origin and leaves unattached providers unchanged.
- Global budgets apply to every model. Scoped budgets and ledger entries follow the cached model-to-limit map.
- Tree bypass skips soft caps, but not enforced hard caps. Disabled hard-cap enforcement remains advisory.
- Reapplying the wrapper in one provider runtime does not stack quota guards.

#### Usage source and cache

- Usage polling stores all snapshots and the opaque model-to-limit map in one cache record.
- DevPass returns an unscoped monthly snapshot plus an independently resetting premium-weekly snapshot, with the correct window bounds.
- DevPass omits an absent premium pool and rejects invalid or failed upstream usage responses.
- Premium model membership uses catalog prices or eligible-provider medians at the established input/output thresholds.
- The runner writes snapshots and model-limit membership atomically for the quota core and prunes ledger entries covered by the snapshot. The runner test uses its executable CLI boundary, rather than importing implementation code.

#### LLM Gateway provider

- The provider registers as `llmgateway` with OpenAI Completions, environment-backed authentication, and no custom stream implementation.
- Fresh stored catalogs and offline runtimes avoid network access.
- Stale catalogs refresh with the supplied abort signal, while a forced refresh bypasses freshness checks.
- Refreshed catalogs publish full stored model records through pi's provider-cache contract, restore across runtimes, and retain only models with streaming and tool support.
- A cancelled refresh does not fetch or publish.

**Review status:** approved

## Steps

**Pre-implementation commit:** `c2b5dbb0bcc379a61d4b1b08bf41e0895f081680`

### Step 1: Resolve quota attachments

Implement `parseQuotaAttachments` and `loadQuotaAttachments` in `extensions/quota-providers/lib/attachments.ts`. Reuse the policy defaults, reserved keys, home expansion, warnings, and agent-directory resolution in `lib/config.ts`. Return `providerId` from each key in `providers`. Preserve disabled entries and pass non-policy settings through unchanged.

Keep `cachePaths` in `lib/config.ts` for usage and ledger paths. Remove its model and token paths. Retire the old provider-implementation types from `lib/types.ts`, leaving `QuotaSource`, `QuotaSourceResult`, `ImplContext`, snapshots, policy, and ledger types. Update `lib/config.test.ts` to exercise the attachment interface and retained paths. Do not change the tests listed in `## Tests`.

**Verify:** `npx vitest run extensions/quota-providers/lib/attachments.test.ts extensions/quota-providers/lib/config.test.ts` passes.
**Status:** done

### Step 2: Persist usage and membership together

Implement `readUsageCache` in `extensions/quota-providers/lib/usage-cache.ts`. Validate the timestamp, every snapshot, and the model-to-limit-ID map as one record. Return `null` for missing, malformed, or incomplete files. Reuse snapshot validation from `lib/snapshot.ts` where practical, and remove the old snapshot-only reader after its callers move to the new interface.

Change `extensions/quota-providers/runner.mjs` to run only the `usage` command. Load the `QuotaSource` with jiti, pass through source settings, validate its result, and atomically write `{ writtenAt, snapshots, modelLimitIds }`. Retain usage locking, the poll freshness guard, and ledger pruning under the ledger lock using the earliest returned `asOf`. Ensure an expired window triggers a refresh even when the cache age is below the poll interval. Remove discovery and token commands, caches, and detached token refresh. Keep the existing CLI flags used by `runner-usage.test.ts`.

Remove discovery and token cases from `runner.test.ts`. Adapt its usage cases and `test/fake-impl.ts` to the quota-source result and retain the freshness and pruning coverage.

**Verify:** `npx vitest run extensions/quota-providers/lib/usage-cache.test.ts extensions/quota-providers/runner-usage.test.ts extensions/quota-providers/runner.test.ts` passes.
**Status:** done

### Step 3: Split DevPass quota and catalog

Implement `extensions/quota-providers/impls/devpass-quota.ts` as a `QuotaSource`. Extract the billing-anchor parsing, monthly-window calculation, `/v1/key` validation, and premium-weekly snapshot logic from `impls/devpass.ts`. Fetch `/v1/models` for model membership. Use catalog input and output prices when present, otherwise eligible streaming-and-tools provider medians. Map models at $5/M input or $15/M output to `premium-weekly`. Return the snapshots and map together, with no provider registration, token, discovery, or retry-classification methods.

Move gateway catalog conversion and its supporting price, modality, reasoning-effort, and output-limit logic from `impls/devpass.ts` to `extensions/llm-gateway/`. Produce `ProviderModelConfig` values with pi's required defaults. Preserve eligible-provider filtering, median costs, image limits, reasoning maps, and minimum output caps. Remove quota membership from the provider model data. Move the catalog behavior coverage in `impls/devpass.test.ts` to the provider extension, adapting assertions to its provider model interface. Remove the encrypted-content retry cases.

**Verify:** `npx vitest run extensions/quota-providers/impls/devpass-quota.test.ts` passes. Catalog coverage passes after the provider refresh in Step 4.
**Status:** done

### Step 4: Register LLM Gateway

Implement `extensions/llm-gateway/index.ts` and retain its extension manifest. Register `llmgateway` with the name, base URL, API, env-backed key, and auth header specified in the architecture. Do not register a custom stream.

Implement `refreshModels` using the catalog conversion from Step 3. Restore stored models when offline or when the stored `checkedAt` is less than one hour old and refresh is not forced. Otherwise fetch `/v1/models` with gateway authentication and the supplied abort signal. Publish full `AnyModel` records with `provider`, `baseUrl`, and `checkedAt` through `context.publish({ persist })`. Return `ProviderModelConfig` values and convert stored records back on restore. Do not fetch or publish after cancellation.

**Verify:** `npx vitest run extensions/llm-gateway` passes, including the moved catalog coverage and the approved refresh, persistence, offline, and cancellation tests.
**Status:** done

### Step 5: Wrap complete providers

Implement `wrapProviderWithQuota` in `extensions/quota-providers/lib/provider-wrapper.ts`. Evaluate the model and request options before `streamSimple`; throw the decision's non-retryable quota message on a block. Delegate allowed streams and preserve every other field and operation of the effective provider, including methods that depend on their receiver. Rewrapping a provider in one runtime must leave exactly one quota guard.

**Verify:** `npx vitest run extensions/quota-providers/lib/provider-wrapper.test.ts` passes.
**Status:** done

### Step 6: Attach quotas at session start

Refactor `extensions/quota-providers/index.ts` to load enabled attachments, resolve each provider through `ctx.modelRegistry.getProvider(providerId)` at `session_start`, and register the complete wrapped provider with `pi.registerProvider(provider)`. Leave unattached providers unchanged. Remove provider grouping, discovery, token commands, custom API streaming, and retry rewriting. Keep usage polling, `/quota`, footer, hard and soft cap policy, and tree-scoped bypass.

Read snapshots and model membership from the same `readUsageCache` record for each quota evaluation. Use that cached membership for `message_end` ledger entries and footer decisions too. Keep session-ID-to-tree-store binding at `session_start` and `agent_start`, and unregister it at shutdown. Preserve detached usage polling and its window-reset behavior.

Remove `impls/foundry.ts`, the combined `impls/devpass.ts`, `lib/registration.ts`, and `lib/retryable-errors.ts` after their retained behavior has moved. Remove tests solely for removed registration and retry-rewrite behavior. Remove `lib/snapshot.ts` if Step 2 moved its validation. Preserve quota, ledger, bypass, and stream-blocking behavior tests that still apply.

**Verify:** `npx vitest run extensions/quota-providers` passes. The attachment integration tests pass for built-in, `models.json`, legacy, and native providers, including scoped ledger accounting and tree bypass.
**Status:** done

### Step 7: Migrate documentation and live harnesses

Update `docs/extensions.md` and the extension summary in `README.md` to distinguish the LLM Gateway provider from quota attachments. Document `LLMGATEWAY_API_KEY`, the `llmgateway` attachment and `billingCycleAnchor`, existing policy defaults, and migration of session and `models.json` references from `devpass-openai-completions` to `llmgateway`. Remove Foundry setup instructions. Update the Quota Providers, Quota Provider Implementations, and new LLM Gateway entries in `codemap.md` to match the resulting ownership.

Update `tools/manual-test/persona-workspaces/run.mjs` and `tools/manual-test/model-tiers/run.mjs` to use the `llmgateway` provider ID and `impls/devpass-quota.ts` attachment. Keep existing policies and journey behavior. Update their README instructions and the relevant `tools/manual-test/README.md` references to match.

**Verify:** Search the active documentation and harnesses for the old DevPass module path and provider ID. Only explicit migration guidance remains. With `pi`, `LLMGATEWAY_API_KEY`, and suitable model IDs available, run `node tools/manual-test/persona-workspaces/run.mjs --only R1,D1` and `MT_PROVIDER=llmgateway node tools/manual-test/model-tiers/run.mjs`; both report PASS. Record any unavailable credentials or model prerequisites instead of claiming a live pass.

**Live harness note:** The live harnesses were not run because credentials and suitable model prerequisites were unavailable.
**Status:** done

### Step 8: Verify the integrated change

Run the full Vitest suite after the legacy test updates. Check that no active quota code imports the removed provisioning or retry modules. Confirm the approved tests remain unchanged and the LLM Gateway manifest is discovered through the existing extension package resource. Do not add a build or type-check step.

**Verify:** `npx vitest run` passes. Compare the approved test files against test-review commit `cdd469b93237234e9c03073f1f0e0e181c819340` and confirm they are unchanged. Report any live-harness prerequisites that prevented Step 7 verification.
**Status:** done
