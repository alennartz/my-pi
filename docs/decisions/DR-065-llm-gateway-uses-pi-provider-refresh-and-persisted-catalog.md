# DR-065: LLM Gateway uses pi provider refresh and persisted catalogs

## Status
Accepted

## Context

The LLM Gateway integration needs a live model catalog, but quota enforcement must not own model provisioning or provider transport. A custom provider implementation would duplicate pi's OpenAI Completions transport, authentication, filtering, and lifecycle behavior. A static `models.json` entry cannot discover the gateway's changing catalog. Keeping a second catalog in the quota runner would duplicate pi's provider cache and cause ordinary parent and subagent sessions to fetch the same catalog independently.

## Decision

Register `llmgateway` as a normal pi `ProviderConfig` using the OpenAI Completions API, the gateway base URL, bearer authentication from `LLMGATEWAY_API_KEY`, and `refreshModels`. Do not provide a custom stream implementation. Convert eligible gateway catalog records into pi provider model configurations, retaining only models with streaming and tool support and deriving pi's pricing, modality, reasoning, and output-limit metadata from the catalog.

The refresh handler uses pi's `ModelsStoreEntry` persistence. It restores stored records without network access when networking is disabled, and reuses records checked less than one hour ago unless a refresh is forced. Otherwise it fetches the catalog with the supplied abort signal, publishes complete `AnyModel` records through `context.publish({ persist })`, and returns the provider configurations converted from those records. Cancellation prevents both the fetch result and persistence from being published.

Alternatives rejected:

- **Custom complete provider and stream:** duplicates pi transport and auth behavior for an integration that uses a supported API.
- **Static `models.json`:** cannot discover the gateway's live catalog.
- **Quota-owned model cache and discovery runner:** duplicates pi's persisted provider catalog and leaves parent/subagent refresh coordination to another cache; quota still keeps only usage and ledger caches.

## Consequences

The provider owns gateway authentication, catalog discovery, model metadata, and streaming. The quota extension can attach to `llmgateway` like any other provider without knowing how models are provisioned. Existing session and model-store references to `devpass-openai-completions` require migration to `llmgateway`.

Pi's catalog freshness and offline behavior become the source of truth. Cold starts in separate processes can still refresh concurrently because no cross-process refresh lock is added. Usage snapshots and local spend ledgers remain separate because provider catalog persistence does not replace quota accounting.
