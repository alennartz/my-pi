# pi-coding-agent delta: 0.76.0 → 0.79.1

Source: `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` (entries 0.77.0–0.79.1).

**No `Breaking Changes` sections exist in this range.** Everything below is additive
API surface, inherited provider fixes, or behavior fixes. The analysis question is
therefore mostly "can this extension take advantage of a new feature / be simplified"
plus "does any behavior fix change an assumption the extension relied on."

## New extension / SDK API surface (candidates for simplification)

- **`ctx.isProjectTrusted()`** (0.79.1) — extensions can observe the effective project
  trust decision (incl. temporary trust).
- **`project_trust` extension event** (0.79.0) — global/CLI extensions can decide,
  remember, or defer project trust before project-local resources load (startup + cwd switch).
- **`defaultProjectTrust` setting** (0.79.1) — global setting: ask / always / never.
- **Autocomplete trigger characters** (0.79.1) — `ctx.ui.addAutocompleteProvider()`
  wrappers can declare trigger chars (e.g. `#`, `$`) so suggestions open without a
  slash-command prefix.
- **`areExperimentalFeaturesEnabled` feature guard** (0.79.1).
- **Prompt template default positional args** (0.79.1) — `${1:-7}` style defaults.
- **Exported RPC extension UI request/response types** (0.79.0).
- **Exported coding-agent package asset path helpers** (0.79.0).
- **`ctx.mode`** (0.78.1) — distinguish TUI / RPC / JSON / print mode.
- **`ctx.getSystemPromptOptions()`** (0.78.1) — inspect current base system prompt inputs.
- **Exported `convertToPng`** (0.78.0).
- **Exported `parseArgs` + type `Args`** (0.78.0).
- **`--name` / `-n`** startup session display name (0.78.0) — across TUI/print/JSON/RPC.
- **OSC 8 `file://` hyperlinks** in built-in file tool titles (0.78.0).
- **`--exclude-tools` / `-xt`** (0.77.0) — disable specific built-in/extension/custom tools.
- **`InputEvent.streamingBehavior`** (0.77.0) — distinguish idle prompts, mid-stream
  steers, queued follow-ups.
- **`pi.getAllTools()` exposes `promptGuidelines`** (0.77.0) per tool.

## Behavior fixes that may change assumptions

- **Session disposal aborts in-flight work** (0.77.0) — agent, compaction, branch
  summary, retry, and bash work are now aborted on disposal.
- **SIGTERM/SIGHUP run `session_shutdown`** (0.77.0) — signal-triggered shutdown emits
  `session_shutdown` before terminal writes; SIGHUP no longer hard-exits, so extension
  resources (sockets, etc.) are released even when the terminal is gone.
- **Follow-ups queued by `agent_end` handlers drain before idle** (0.77.0).
- **API key / header config resolution** (0.77.0) — plain strings are literals;
  `$ENV_VAR` / `${ENV_VAR}` interpolation and `$!` bang escaping supported; explicit env
  syntax required in config files.
- **Temp extension installs** now use `~/.pi/agent/tmp/extensions` (`0700`) (0.78.1).
- **SDK `createAgentSession()`** tolerates missing adjacent `package.json` (0.78.1).
- **`httpIdleTimeoutMs`** now applies to all providers, not just Codex (0.78.1).
- **Package exports**: stale `./hooks` subpath removed (0.79.0).

## Inherited provider/model fixes (mostly automatic via pi-ai bump)

- **Claude Fable 5** on Anthropic + Bedrock, adaptive thinking + `xhigh` effort (0.79.1).
- **Claude Opus 4.8** metadata + adaptive-thinking coverage (0.77.0).
- Azure OpenAI Responses: disable server-side response storage (0.79.1).
- Azure GPT-5.4/5.5 context window → 1,050,000 (0.79.1); GPT-5 Pro `maxTokens` → 128,000.
- MiniMax-M3, Ant Ling, NVIDIA NIM provider coverage (0.78.1).
- Various thinking-off / reasoning-effort compatibility fixes for z.ai, Kimi, OpenRouter, etc.
