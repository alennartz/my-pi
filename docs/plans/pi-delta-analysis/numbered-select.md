# Delta analysis: `extensions/numbered-select`

Scope analyzed: `extensions/numbered-select/index.ts` plus its only dependency,
`lib/components/numbered-select.ts` (the `showNumberedSelect` helper + custom TUI
component).

What the extension actually does / which pi APIs it touches:

- `pi.registerTool({ name: "ask_user", ... })` with a TypeBox schema.
- Reads `process.env.PI_PARENT_LINK` to skip registration in subagent children.
- In `execute`: `ctx.hasUI`, then `showNumberedSelect(ctx, ...)`.
- `showNumberedSelect`: `ctx.ui.custom(...)` first, falls back to `ctx.ui.select(...)`.
- pi-tui imports (`Input`, `matchesKey`, `Key`, `truncateToWidth`, `wrapTextWithAnsi`).
- Ignores the `_signal` (AbortSignal) and `_onUpdate` args passed to `execute`.

## Breaks (with fix)

**None.** The 0.76→0.79 range has no `Breaking Changes` sections, and nothing in the
additive surface or behavior fixes invalidates an assumption this extension relies on.

One item is worth flagging as a *latent robustness gap that the 0.77.0 disposal change
makes more reachable* — but it is not a break of existing behavior:

- **Session disposal aborts in-flight work (0.77.0).** `ask_user.execute` receives an
  `AbortSignal` (`_signal`) and ignores it. `showNumberedSelect` awaits
  `ctx.ui.custom(...)`, which resolves only when the component calls `done(...)`. If a
  session is disposed while the prompt is open, the abort signal now fires, but nothing
  in this extension is wired to it, so the awaited promise may never settle and the UI
  component may linger. This was already true before 0.77.0; the change only makes the
  signal *fire* in more cases. Skeptical read: whether this actually leaks depends on
  whether `ctx.ui.custom` itself tears down on disposal (unverified here). **Fix, if
  desired:** thread `_signal` through `showNumberedSelect`, register an
  `abort` listener that calls the component's `cancel()`/`done(undefined)`, and resolve
  the promise. This is a hardening opportunity, not a required fix.

## Simplifications (with how)

The headline item — **autocomplete trigger characters for
`ctx.ui.addAutocompleteProvider()` (0.79.1)** — has **no impact** here. This extension
registers a *tool*; it never calls `addAutocompleteProvider`. There is no autocomplete
provider, no slash-command wrapper, and no trigger-character logic to simplify. Do not
let the "pay special attention" framing manufacture a change that has no anchor in this
code.

Genuinely marginal candidates (recommend **not** adopting unless touched for other
reasons):

- **`ctx.mode` (0.78.1).** Could let `showNumberedSelect` branch upfront on
  TUI vs RPC/JSON/print instead of probing via "`ctx.ui.custom` returned `undefined`".
  *How it would look:* check `ctx.mode === "tui"` before attempting the custom
  component, else go straight to the `ctx.ui.select` fallback. *Why skip it:* the
  current probe (custom returns `undefined` when it can't render) is robust, handles
  every non-TUI environment uniformly, and is fewer moving parts than enumerating modes.
  Adopting `ctx.mode` would add a branch without removing the fallback path. Net: not a
  simplification.

- **Exported RPC extension UI request/response types (0.79.0).** The fallback path uses
  `ctx.ui.select`, which already returns a typed value; the extension never hand-builds
  RPC payloads. The new exports buy nothing here.

## No-impact summary

All of the following are irrelevant to this extension:

- `ctx.isProjectTrusted()`, `project_trust` event, `defaultProjectTrust` setting — no
  trust logic; tool is purely UI.
- **Autocomplete trigger characters** — extension is a tool, not an autocomplete
  provider (see Simplifications for the explicit rationale).
- `areExperimentalFeaturesEnabled` — no experimental gating.
- Prompt template default positional args (`${1:-7}`) — no prompt templates.
- Exported asset path helpers, `convertToPng`, `parseArgs`/`Args` — none imported.
- `ctx.getSystemPromptOptions()` — system prompt not inspected.
- `--name`/`-n` session display name — startup CLI flag, unrelated.
- OSC 8 `file://` hyperlinks in file-tool titles — built-in file tools, not this tool.
- `--exclude-tools`/`-xt` (0.77.0) — users *can* now disable `ask_user` via this flag,
  but that is a user/operator capability requiring zero code change here.
- `InputEvent.streamingBehavior` — extension doesn't observe input events.
- `pi.getAllTools()` exposing `promptGuidelines` — extension sets its own `promptSnippet`
  and never reads other tools' metadata.
- SIGTERM/SIGHUP `session_shutdown` (0.77.0) — extension holds no sockets/resources to
  release; nothing to clean up on shutdown.
- Follow-ups draining before idle, API key/header config resolution, temp extension
  install dir, `createAgentSession()` missing-`package.json` tolerance,
  `httpIdleTimeoutMs`, stale `./hooks` export removal — all infrastructure/SDK concerns
  the extension never touches (it imports only the main package + `typebox` + `pi-tui`).
- All inherited provider/model fixes (Claude Fable 5, Opus 4.8, Azure, MiniMax, Ling,
  NIM, reasoning-effort compat) — automatic via the pi-ai bump; no extension surface.
