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
