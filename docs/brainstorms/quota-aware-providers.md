# Quota-Aware Providers

## The Idea

Generalize the `azure-foundry` extension into a single generic **quota-aware providers** extension. New model providers (starting with an HTTP-based wrapper around a Foundry) plug in through typed seams instead of copying the extension. The headline new feature is quota awareness: pro-rated spend backpressure so you don't accidentally burn a provider's whole billing window early.

Scope constraint: providers reuse pi's built-in `api` streamers (`anthropic-messages`, `openai-responses`, `openai-completions`, …). No new protocol implementations — only new providers for existing protocols.

## Key Decisions

### One generic extension + typed seams, not config-only and not per-provider extensions

- **Config-only (scripts + `models.json`) was considered and rejected.** Auth alone *is* fully coverable by `models.json` (`!command` apiKey, self-caching script). But the model list in `models.json` is static JSON; a generator script writing the file means two writers to one hand-edited global file, no cold-start block-once hook, no refresh-cadence ownership, and — decisive — loss of pi-ai catalog metadata lookup (`getModel()`), which was a deliberate fix for metadata drift.
- **Declarative descriptors (pure config per provider) rejected** because discovery output shapes and backend-resolution rules differ per provider (Foundry's `az` fields vs. an HTTP API); a descriptor language would grow escape hatches until it's code again. Plug points stay *functions*.
- **Chosen shape:** one generic extension (not foundry-branded) + a small lib of TypeScript types defining the seams + a config file the extension reads to discover provider implementations (TS modules implementing the seams). Azure Foundry becomes the first implementation.

### The three seams

1. **Model discovery** — implementation supplies the raw fetch (out-of-band script or HTTP call) and a mapping from raw entry → (model name, backend). Core owns everything else: file cache, block-once on cold miss, detached background refresh with floor/TTL cadence, process sentinel, pi-ai catalog metadata lookup, `pi.registerProvider()` per backend. This machinery is already provider-agnostic in the current extension; only the two `az` calls are Foundry-specific.
2. **Auth** — implementation supplies a self-caching token command; core wires it as the provider `apiKey` (`!command`). Deliberately thin: pi's request-time command resolution already does the heavy lifting; caching/expiry-margin logic lives in the implementation's script (the existing foundry-helper pattern).
3. **Usage** — `getUsage()` reports **provider facts**: current spend, quota, window start / cadence, reset time. The upstream provider's hard limit (e.g., $X/month) is the ground truth; the seam surfaces it.

### Spend tracking: polled authoritative source + local ledger

- `getUsage()` is polled frequently (configurable max poll frequency) because concurrent use — other machines, other tools, parallel pi processes — must be supported.
- Between authoritative snapshots, a local ledger accumulates pi-observed per-message costs (from `message_end` / model cost rates) on top of the last snapshot; the ledger resets on every fresh snapshot. This covers laggy upstream reporting (e.g., Azure cost data trailing hours behind).
- Ledger and caches are shared files with atomic writes (same discipline as the existing token cache), safe across concurrent pi processes.

### Enforcement model: pro-rated lookahead, soft/hard caps

- **Soft cap (the core logic):** block when current spend exceeds the linear pro-rated projection of the quota evaluated at **now + offset**. The offset (default **6 hours**) is the configurable tolerance — literally "how many hours ahead of budget you're allowed to be." Explicitly *not* a rate-over-window calculation; it's a lookahead against the burn line. The same number drives the display.
- **Hard cap blocking is opt-in, default off.** Normally the upstream provider enforces its own limit; the option exists for upstreams that don't really enforce, or where overage silently moves you to pricier or smaller models.
- **Enforcement point: prompt boundary only** (the `input` event can intercept and refuse). No mid-loop interruption — pi has no documented turn-cancel hook, and prompt-boundary was judged sufficient.

### Bypass: session-scoped, live-propagating to subagents

- Crossing the soft cap blocks new prompts unless bypassed. Bypass is **session-scoped** (a `/quota bypass`-style toggle, off by default each session) — an explicit decision to eat into future budget.
- **Subagent propagation:** an env var carries only an immutable *scope id* (root session id) inherited at spawn; bypass *state* lives in a shared file keyed by scope id. Toggling in the parent reaches already-running children at their next prompt. Rejected: env-var-carried state (spawn-time snapshot → respawn-to-recover wrinkle, judged bad UX); uniform machine-wide bypass (breaks session scoping).
- **Zero coupling to the subagents extension:** a blocked child prompt fails with a distinctive error ("quota soft cap exceeded — bypass not active") that bubbles up through normal agent output. The subagents extension never learns quota exists.

### Provider facts vs. user policy

- **From the seam (provider facts):** spend, quota, window start/cadence, reset time.
- **From user config (policy):** whether soft-cap bypass is allowed at all, the lookahead offset (default 6h), max poll frequency, whether hard-cap blocking is enabled.
- User config never overrides provider facts.

### Display

- Footer/statusline indicator showing how far ahead of budget you are in time ("spending at July 19's budget").
- A `/quota` command for detail: spend, caps, window, reset time, bypass state.

## Direction

Build the generic quota-aware-providers extension: typed seams lib, implementation-discovery config file, the discovery/auth core extracted from `azure-foundry`, and the quota core (usage polling + ledger, lookahead soft cap, session-scoped bypass with shared-file propagation, opt-in hard cap, footer + `/quota` UI). Port Azure Foundry as the first seam implementation; the new HTTP-based foundry wrapper follows as the second.

## Open Questions

- Exact seam type signatures and the config file format/location (architect phase).
- Extension/lib naming.
- Whether jiti's extension loading imposes constraints on sharing the lib module across implementation modules.
- The new provider's concrete HTTP API details (discovery, token, usage endpoints) — deliberately deferred; core first.
- What `getUsage()` should do for providers that can't report spend or quota (seam optionality).
