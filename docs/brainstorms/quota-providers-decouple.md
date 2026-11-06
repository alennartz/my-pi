# Quota providers decoupling

## The idea

Separate dynamic model provisioning from quota enforcement. Quotas must attach to any explicitly configured pi provider, whether its models come from pi's built-in catalog, `models.json`, or an extension.

## Key decisions

- **LLM Gateway becomes a normal provider extension.** It owns gateway authentication and dynamic model discovery through `refreshModels`. The endpoint uses a pi-supported API, so pi supplies streaming. Do not load this provider through the quota extension or add a custom stream implementation.
- **Quota Providers becomes quota-only.** Keep it as a separate extension. A quota attachment names a provider ID and supplies its usage source and policy. Attachments are provider-level; the usage source can preserve provider-specific pools and model-to-pool associations.
- **Usage polling remains essential.** Provider usage snapshots provide cross-machine accounting. Keep the local spend ledger as a supplement between polls, not as a substitute for polling.
- **Preserve DevPass quota semantics.** Keep its monthly and premium-weekly usage windows and the association between premium models and the weekly pool. Move catalog discovery and model API authentication out of its quota source.
- **Remove Foundry.** Delete its quota-provider implementation and configuration. Reintroduce Azure only as a separate provider integration if requested later.
- **Keep one quota configuration file.** The LLM Gateway provider extension does not require a separate integration file for this design. Keep `quota-providers.json` as the quota attachment configuration path unless implementation work finds a concrete need to rename it.
- **Block at the provider stream boundary.** `before_provider_request` transforms payloads but cannot cancel a request; extension errors are caught and the request proceeds. Quota blocks must fail before the provider call, preserving the current failed-turn behavior.

## Direction

Use pi's dynamic provider registration for LLM Gateway and keep quota enforcement independent. Quota attachments explicitly target provider IDs and load their own usage sources. The enforcement core owns polling, snapshots, local ledger, caps, bypass, `/quota`, and footer behavior. Provider-specific quota sources own usage interpretation and pool membership.

## Sharp questions for architecting

- What is the least-code way to install the blocking stream wrapper on every attached provider while preserving the provider's implementation? A legacy `ProviderConfig` overlay merges with an existing registration, but registering it over a complete native `Provider` removes that native registration. Verify a safe wrapper path for built-in providers, `models.json` providers, legacy extension providers, and complete native providers.
- How should the DevPass usage source expose premium-model-to-pool membership after model discovery moves to the LLM Gateway provider extension? Keep the mapping provider-specific without restoring quota ownership of the model catalog.
- Which model-refresh persistence and cache behavior best serves normal sessions and subagent sessions without duplicate catalog requests?

## Fog

- The exact quota-source module contract and config field names remain open until architecture defines the clean seam.
- Foundry is out of scope; its future return would be a separate provider-integration decision.
