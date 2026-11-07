# DR-064: Quota attachments wrap complete providers and keep limit semantics source-owned

## Status
Accepted

## Context

Quota enforcement must attach to providers that pi already knows, including built-in providers, `models.json` providers, and extension providers. The old integration combined provider registration, model discovery, authentication, and quota policy, so it could not attach safely to arbitrary provider origins. Pi's legacy provider-config overlay also cannot preserve a complete native provider: accepting that overlay removes the native registration. The `before_provider_request` hook cannot block a request because the extension runner catches handler errors and continues.

Provider-specific quota pools create a second boundary. A generic core must not learn names such as `premium` or periods such as `weekly` merely to support one provider's account. The source that understands the provider's usage response must also decide which models belong to each pool.

## Decision

A quota attachment names an existing pi provider ID. At session boundaries, quota providers resolve that ID through the effective model registry and install an idempotent guard at the provider's `streamSimple` seam. The guard evaluates quota before transport, then delegates every other provider field and operation to the original complete provider. Refresh reattachment keeps the guard stable across pi's provider composers and updates the evaluator rather than stacking wrappers. Unattached providers remain unchanged.

A `QuotaSource` only reports usage snapshots and a model-to-limit map. `UsageSnapshot.limitId` is opaque to the quota core: an omitted ID applies globally, while a present ID applies to models mapped to it by the source. The usage runner writes snapshots and membership together as one cache record, and the core uses that record for blocking, ledger membership, and status output.

Alternatives rejected:

- **Partial provider-config overlays:** they do not preserve complete native providers and can remove the registration they are meant to extend.
- **`before_provider_request`:** extension-runner error handling lets the request continue, so it cannot enforce a block.
- **Provider-specific rules in the generic core:** recognizing pool names or reset periods couples quota enforcement to one provider and prevents independent source adapters.

## Consequences

Provider integrations retain ownership of model catalogs, authentication, streaming, and retry behavior. Quota code owns polling, snapshots, ledger accounting, caps, bypass, and the pre-transport block. Source adapters must validate their own pool membership and expose it with each usage poll. The atomic cache record prevents a snapshot from being evaluated with a model map from another poll.

The supported attachment boundary covers pi built-ins, supported `models.json` APIs, and the current DevPass provider. A third-party extension that replaces the same provider ID during a running session before quota reattachment is outside the guarantee because pi exposes no pre-dispatch hook for that replacement. Reattachment and wrapper state add lifecycle complexity, but they preserve provider capabilities without requiring a pi host change.
