# pi 0.76→0.79 delta analysis: `extensions/toolscript/`

## What the extension is

A bridge that spawns the `toolscript` binary as an MCP server over stdio, lists its
tools at `session_start`, and registers each as a pi tool named `toolscript_<name>`
via `pi.registerTool()`. `client.ts` owns the MCP lifecycle (connect, listTools,
callTool, crash-restart, stop). It uses three pi hooks only: `session_start`,
`session_shutdown`, and `registerTool`. It does **not** call `pi.getAllTools()`,
`parseArgs`, or any CLI-arg API, and it does not gate on project trust.

---

## Breaks (with fix)

None. The 0.77–0.79 range has no `Breaking Changes` sections, and every relevant item
is additive or a behavior fix that strengthens — never invalidates — an assumption this
extension relies on. Specifically:

- The extension already sets `promptGuidelines` and `promptSnippet` on `registerTool`,
  so the 0.77 `promptGuidelines` work is consistent with what it already does — no field
  was renamed or removed out from under it.
- It imports nothing from `./hooks`, so the removed stale `./hooks` export (0.79.0) is
  irrelevant.

---

## Simplifications (with how)

None that change code. The three items flagged for attention do not apply here:

- **`pi.getAllTools()` exposes per-tool `promptGuidelines` (0.77.0)** — This is an
  *introspection* improvement: it lets a reader of the tool registry see each tool's
  guidelines. Toolscript is a *producer* — it registers tools and never reads the
  registry back. It already supplies `promptGuidelines` (the upstream MCP `instructions`
  string, attached to the first tool only, `i === 0`). Nothing to consume here. **No
  simplification.**

- **Exported `parseArgs` + type `Args` (0.78.0)** — This is pi's *CLI* argument parser.
  The args the extension builds in `client.ts`
  (`["run", "--config", <file>, ...]`) are the command line for the **toolscript child
  binary**, a completely separate arg domain that pi's parser knows nothing about. Using
  `parseArgs` here would be wrong, not simpler. **No simplification.**

- **`--exclude-tools` / `-xt` (0.77.0)** — Lets the *user* disable specific built-in /
  extension / custom tools at startup. Because the toolscript tools are registered with
  stable, prefixed names (`toolscript_<name>`), users can already exclude them with
  `-xt toolscript_<name>` for free, with no extension code change. This is a user-facing
  capability, not an internal simplification. Worth a line in the extension's README, but
  there is nothing to refactor. **No code simplification.**

### Minor, optional

- **`ctx.mode` (0.78.1)** — The extension could in principle skip the background MCP boot
  in non-interactive modes (e.g. `json`/`rpc`) where the tools may never be used. But a
  print/JSON run can legitimately call tools, so suppressing the boot risks breaking those
  paths. Speculative and low-value; recommend **not** doing it unless a concrete need
  appears.

---

## No-impact summary

Everything else is irrelevant to this extension. Grouped:

**New API surface — not used, not applicable:**
- `ctx.isProjectTrusted()`, `project_trust` event, `defaultProjectTrust` setting — the
  extension does not gate behavior on trust.
- Autocomplete trigger characters — no autocomplete provider registered.
- `areExperimentalFeaturesEnabled` — no experimental gating.
- Prompt template default positional args (`${1:-7}`) — no prompt templates.
- Exported RPC UI request/response types — no RPC UI.
- Exported asset-path helpers — no asset access.
- `ctx.getSystemPromptOptions()` — does not inspect the base system prompt.
- Exported `convertToPng` — no image handling.
- `--name` / `-n` session display name — unrelated.
- OSC 8 `file://` hyperlinks in built-in file-tool titles — toolscript tools aren't file
  tools.
- `InputEvent.streamingBehavior` — no input-event handler.

**Behavior fixes — mostly unrelated; one is a quiet improvement:**
- **SIGTERM/SIGHUP now run `session_shutdown` (0.77.0)** — *Positive, no code change.*
  The extension relies on its `session_shutdown` handler calling `c.stop()` to kill the
  spawned toolscript child. Previously SIGHUP hard-exited without firing
  `session_shutdown`, which could orphan the child process. Now the handler fires on
  signal-triggered shutdown too, so the existing cleanup path actually runs in more cases.
  This strengthens an assumption the code already made — no fix required.
- Session disposal aborts in-flight work (0.77.0) — concerns pi-managed agent/compaction/
  bash work, not the extension's own `startPromise`; `session_shutdown` already awaits
  that promise.
- Follow-ups draining before idle (0.77.0) — no `agent_end` handler.
- API key / header config interpolation (0.77.0) — the extension reads its own
  `toolscript.toml` via the child binary; it does not use pi's config interpolation.
- Temp extension install dir, `createAgentSession` package.json tolerance,
  `httpIdleTimeoutMs` across providers — unrelated to runtime behavior here.

**Inherited provider/model fixes (Fable 5, Opus 4.8, Azure, MiniMax, etc.)** — model-layer
changes; **no impact** on a tool-bridge extension.
