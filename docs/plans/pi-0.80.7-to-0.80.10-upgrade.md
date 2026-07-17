# Plan: Pi 0.80.7 → 0.80.10 Upgrade

## Context

Upgrade this package's installed Pi SDK pair from 0.80.7 to 0.80.10 while preserving its extension behavior. The breaking change is concentrated in native subagent session construction: Pi now owns model and credential behavior through a `ModelRuntime` rather than the legacy shared `AuthStorage` and `ModelRegistry` SDK inputs.

## Architecture

### Impacted Modules

#### Subagents

`extensions/subagents/` continues to own in-process child-session lifecycle, parent-local routing, scoped extension loading, and presentation. Each child runtime will own a fresh SDK `ModelRuntime`, created by `createAgentSessionServices()` for that child's effective cwd and the common Pi agent directory.

Children will share persisted Pi state through the standard `auth.json`, `models.json`, and `models-store.json` locations, rather than sharing a parent in-memory auth store or model registry. This follows the SDK's multi-process model: Pi locks mutable credential and dynamic-catalog stores, while each runtime owns its live credential and model snapshots. Runtime-only credentials and transient snapshots remain local to their runtime.

The child resource loader remains responsible for loading child-scoped extensions before model resolution. Its registered provider configurations therefore become part of the child's `ModelRuntime` before a requested model reference is resolved. Root-side spawn validation continues to use the extension-facing `ctx.modelRegistry` compatibility facade; it is not used to construct a child runtime.

#### Quota Providers

`extensions/quota-providers/` continues to resolve optional static metadata for externally supplied models and register provider configurations through Pi's extension bridge. It will use Pi-AI's supported built-in catalog entrypoint instead of the deprecated `pi-ai/compat` static lookup, preserving its existing conservative fallback for unknown models.

#### Package Metadata

The root package metadata and lockfile will resolve `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` as the matching 0.80.10 release pair. No additional dependency is introduced.

### Interfaces

#### Managed child runtime construction

`ManagedChildSessionDependencies` narrows to the only persistent construction input the subagent module owns:

```ts
type ManagedChildSessionDependencies = {
  agentDir: string;
};
```

For each runtime generation—initial creation, resume, fork, reload, new session, or session switch—`createManagedChildSession()` must:

1. create cwd-bound services with the effective cwd and `agentDir`, without legacy auth/registry options;
2. resolve `config.modelRef` against `services.modelRuntime` after those services load scoped extensions and register their providers;
3. create the child session from those same services.

The registry continues to receive this dependency object and owns no model, credential, or provider state itself. Its interface to managers, routing, persistence, and UI is unchanged.

#### Static catalog metadata

`resolveModelMeta(catalogProvider, modelName)` remains a synchronous lookup with the current contract:

- return catalog-derived reasoning, input, context, cost, thinking-map, and adaptive-thinking fields when a built-in model exists;
- return conservative defaults when no catalog provider or model exists.

Only its catalog adapter changes, from deprecated `getModel` in `@earendil-works/pi-ai/compat` to the supported built-in catalog lookup.

### Technology Choices

Use the public child-local `ModelRuntime` created by `createAgentSessionServices()`.

This was chosen over extracting the root runtime from `ctx.modelRegistry`, because the extension context exposes only a compatibility facade and its underlying runtime is private implementation detail. It was also chosen over maintaining a package-owned shared `ModelRuntime`, which would duplicate Pi's lifecycle, make scoped extension-provider registration ambiguous, and reintroduce shared mutable runtime state across children.

No custom locking or credential-store adapter is added. Pi's file-backed auth and dynamic model catalog stores already coordinate independent Pi processes; child runtimes use the same supported persistence mechanism.

### DR Supersessions

- **DR-044** (In-Process Child Sessions with Parent-Local Routing) — superseded only in its statement that root auth storage and the model registry are shared with children. Pi 0.80.10 replaces those public SDK construction inputs with `ModelRuntime`, and does not expose the root runtime through `ExtensionContext`. New decision: each child owns an SDK-created `ModelRuntime` backed by the common persisted Pi configuration and stores; routing, registry ownership, scoped session construction, and all other DR-044 decisions remain unchanged.

## Tests

**Pre-test-write commit:** `322bfb71e00e79c49a7ec759f122fdba4baf700f`

### Interface Files

- `extensions/subagents/managed-child-session.ts` — existing managed-child construction seam under test; its production interface is intentionally unchanged during this red-test phase.

### Test Files

- `extensions/subagents/managed-child-session.test.ts` — child-runtime construction and replacement contracts for the ModelRuntime migration.

### Behaviors Covered

#### Managed child runtime construction

- A child resolves its requested model against the `ModelRuntime` returned by its own cwd-bound services.
- Child-service creation receives only its cwd and agent directory, not a parent auth store or model registry.
- Sibling child sessions receive distinct model-runtime instances while retaining distinct event buses and settings services.
- Session replacement creates a fresh model runtime and resolves the replacement session's model against it.
