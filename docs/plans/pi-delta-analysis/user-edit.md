# pi 0.76→0.79 delta analysis: `extensions/user-edit/`

## What the extension does

Registers one custom tool, `user_edit`. It guards on `ctx.hasUI`, normalizes a
leading `@`, resolves the path against `ctx.cwd`, reads existing content (empty for
`ENOENT`), opens `ctx.ui.editor(title, content)`, and on save writes through
`withFileMutationQueue`. Surface area touched: `pi.registerTool`, `ctx.hasUI`,
`ctx.cwd`, `ctx.ui.editor`, `withFileMutationQueue`. No image handling, no sockets,
no `agent_end`/shutdown hooks, no config/env reads, no CLI-arg parsing.

## Breaks

**None.** There are no `Breaking Changes` sections in 0.77–0.79.1, and nothing in the
behavior-fix list intersects this extension's surface.

The one fix worth checking is **session disposal aborting in-flight work** (0.77.0).
`execute` receives a `_signal` and ignores it; an open `ctx.ui.editor` promise is the
only long-lived await here. This is *not* a break:

- Editor lifecycle is owned by pi's TUI, not by this extension. If the session is
  disposed while the editor is open, pi tears the UI down — the extension doesn't need
  to wire `_signal` into `editor()` to make that happen.
- Worst case the `editor()` promise rejects/never resolves on disposal, but that path
  ends the process anyway; there is no resource (socket, watcher, temp file) that would
  leak. Nothing to fix.

## Simplifications

**None that are worth making.** Walking the three flagged items and the rest:

- **Exported `convertToPng` (0.78.0):** This extension only edits text files and never
  produces tool-result images. No use. **No impact.**
- **OSC 8 `file://` hyperlinks in file tool titles (0.78.0):** This feature decorates
  the *built-in* file tools' (read/write/edit) titles. `user_edit` is a custom tool and
  its visible "title" is the `editor()` argument (`rawPath`), not a tool-result title
  rendered by that subsystem. The feature does not reach this code and there is no
  documented API here to opt a custom tool's title into the same hyperlinking. Leaving
  `rawPath` as a plain string is correct. **No impact.** (If anything, hand-rolling an
  OSC 8 escape into the editor title would be a regression — the editor expects a plain
  label.)
- **`ctx.mode` (0.78.1):** Tempting as a replacement for `ctx.hasUI`, but it is the
  wrong tool. The guard's intent is "can I open an interactive editor right now," which
  is exactly what `hasUI` answers. `ctx.mode` distinguishes TUI/RPC/JSON/print, and an
  RPC client can be interactive without being TUI — switching to a `mode === "tui"`
  check would *narrow* the guard incorrectly and break RPC front-ends that can still
  surface an editor. Keep `hasUI`. **No simplification.**

## No-impact summary

Every remaining delta item is irrelevant to this extension:

- `ctx.isProjectTrusted()`, `project_trust` event, `defaultProjectTrust` — no trust
  logic here.
- Autocomplete trigger chars — no autocomplete provider registered.
- `areExperimentalFeaturesEnabled` — no experimental gating.
- Prompt-template default positional args — no prompt templates.
- Exported RPC UI request/response types — not consumed.
- Exported asset path helpers — no asset paths used.
- `ctx.getSystemPromptOptions()` — no system-prompt inspection.
- Exported `parseArgs` / `Args` — no CLI parsing.
- `--name`/`-n` session display name — unrelated.
- `--exclude-tools`/`-xt` — a user can now disable `user_edit` from the CLI, but that is
  pure runtime config; zero code change.
- `InputEvent.streamingBehavior` — no input-event handling.
- `pi.getAllTools()` exposing `promptGuidelines` — this extension reads no other tools'
  guidelines, and `registerTool` here sets none. No use.
- SIGTERM/SIGHUP `session_shutdown`, follow-up draining, API-key/header resolution,
  temp-install dir, `createAgentSession` package.json tolerance, `httpIdleTimeoutMs`,
  removed `./hooks` subpath (not imported), and all provider/model fixes — none touch
  this extension's code path.

**Bottom line:** no breaks, no worthwhile simplifications. The current `hasUI` guard and
plain-string editor title are the correct choices, not legacy patterns the delta lets us
retire.
