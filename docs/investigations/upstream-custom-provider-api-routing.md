# Upstream bug: custom `streamSimple` providers hijack all traffic for their `api`

**Component:** `@earendil-works/pi-coding-agent` (model registry + `@earendil-works/pi-ai` api registry / stream dispatch)
**Observed against:** pi v0.5.0 (`20260602T202637Z-v0.5.0`); code paths unchanged in v0.6.0 as of writing.
**Severity:** High — a single extension that registers a custom `streamSimple` silently breaks every other provider that shares the same `api` string.

## Summary

When an extension registers a provider with a custom `streamSimple` (e.g. to add Azure AI
Foundry models backed by the `anthropic-messages` api), pi stores that handler **keyed by
the `api` string, with exactly one handler per api**. Registration overwrites the global
handler for that api. From then on, **every** model whose `model.api` matches — regardless
of which provider it belongs to (Copilot, built-in Anthropic, Bedrock, …) — is dispatched
through that one extension's `streamSimple`. The provider identity is never consulted at
dispatch time.

The extension that "won" the api then receives requests for models it does not own. Best
case it throws; worst case it blocks.

## Reproduction

1. Have two providers that serve the same `api` (here `anthropic-messages`), e.g. GitHub
   Copilot's Claude models and a custom Azure Foundry extension that registers
   `streamSimple` for `anthropic-messages`.
2. In the TUI, `/model` → select the **Copilot** Claude model.
3. Send a message.

**Expected:** request streams via Copilot's built-in `anthropic-messages` handler.
**Actual:** request is dispatched through the Foundry extension's `streamSimple`. Since the
selected model id is not one of Foundry's deployments, the extension throws
`azure-foundry: unknown deployment "<id>"`. If the id *does* collide with a Foundry
deployment name, it instead runs the extension's auth path (a blocking
`execSync("az account get-access-token …")`), sending the Copilot request to the wrong
backend.

### Secondary failure mode: wedged subagents / RPC children

In an RPC child (used by the subagents extension), when the hijacked handler's auth path is
a synchronous, event-loop-blocking call (`execSync`) and that call hangs (not logged in,
MFA prompt, slow network), the **entire child event loop blocks**. The child cannot stream,
answer RPC, or report progress, so it appears as a permanently idle agent. The symptom
("subagent sits idle forever") has no error and no obvious cause from the parent's side.

## Root cause (code walk)

1. **Registration is per-api.**
   `core/model-registry.js` → `applyProviderConfig`:
   ```js
   if (config.streamSimple) {
     registerApiProvider({
       api: config.api,
       stream: (model, ctx, opts) => config.streamSimple(model, ctx, opts),
       streamSimple: config.streamSimple,
     }, `provider:${providerName}`);
   }
   ```

2. **The api registry holds one handler per api and last-write-wins.**
   `@earendil-works/pi-ai/dist/api-registry.js`:
   ```js
   export function registerApiProvider(provider, sourceId) {
     apiProviderRegistry.set(provider.api, { /* … */ });   // keyed by api only
   }
   export function getApiProvider(api) {
     return apiProviderRegistry.get(api)?.provider;
   }
   ```

3. **Dispatch resolves purely by `model.api`.**
   `@earendil-works/pi-ai/dist/stream.js`:
   ```js
   export function streamSimple(model, context, options) {
     const provider = resolveApiProvider(model.api);   // provider name ignored
     return provider.streamSimple(model, context, options);
   }
   ```
   The only guard is `wrapStreamSimple`, which checks `model.api === api` — satisfied by any
   provider sharing that api, so it does not isolate providers.

Net: there is no per-provider override of `streamSimple`. The api→handler table is global
and singular, so two providers on the same api cannot coexist when one registers a custom
streamer.

## Impact

- Any extension adding models via a custom `streamSimple` for a common api
  (`anthropic-messages`, `openai-responses`, `openai-completions`) silently captures all
  traffic for that api, breaking built-in and other-extension providers on the same api.
- Failures are confusing: the error surfaces from an extension the user did not select, or
  manifests as a hung session with no error at all.

## Suggested fix (upstream)

Dispatch should prefer a **provider-specific** stream override and fall back to the api-level
handler only when the selected model's provider did not register one. Concretely:

- Key custom `stream`/`streamSimple` registrations by `(provider, api)` rather than by `api`
  alone, and resolve at dispatch time using `model.provider` first, `model.api` second.
- Equivalently: a model carrying a provider that registered its own streamer must route to
  that streamer; models on the same api whose provider did **not** register one fall through
  to the built-in api handler.

This preserves the extension ergonomics (register a provider with a custom streamer) while
guaranteeing an extension only ever receives requests for the provider it registered.

## Workaround (extension-side, until fixed)

A custom-`streamSimple` extension can capture the previously-registered api handler at
registration time (`getApiProvider(api)` before overriding) and, inside its own streamer,
delegate any model it does not own (`model.provider` not one of its registered provider ids)
back to that prior handler instead of throwing or running its own auth path. See the
companion plan for the Azure Foundry extension in this repo.
