# pi 0.76→0.79 delta analysis: `session-resume` extension

Scope: `extensions/session-resume/` (`index.ts`, `debug.ts`) against the
0.76→0.79.1 changelog delta (`docs/plans/pi-0.76-to-0.79-changelog-delta.md`).
No code edited.

## What the extension actually does (assumptions it leans on)

- `agent_end` → append a `session-idle` custom entry. So **a cleanly-completed
  turn leaves the branch ending in `session-idle`.**
- `session_start` → if the session has a *file* and has entries and the branch
  does **not** end in `session-idle` (i.e. the last meaningful entry is a
  message/tool_call/tool_result/thinking with no trailing idle marker), assume
  the process died mid-turn and re-trigger the agent with a hidden
  `[session resumed]` message (`triggerTurn: true`).
- Ephemeral sessions (no `getSessionFile()`) are skipped on `session_start`.
- Imports only `ExtensionAPI` from the package root.

The load-bearing assumption is: **mid-turn death = no `agent_end` = no idle
marker.** Everything hinges on that.

---

## Breaks (with fix)

### 1. Session disposal aborts in-flight work (0.77.0) — *potential* spurious-resume break

> "Session disposal aborts in-flight work — agent, compaction, branch summary,
> retry, and bash work are now aborted on disposal."

This touches the one assumption the extension is built on. Before 0.77.0, a
clean exit (`quit`, `/new`, session switch) while a turn was mid-stream left the
in-flight agent in an undefined state. As of 0.77.0 disposal **deterministically
aborts** the running turn.

The open question the extension's correctness depends on: **does an aborted turn
still fire `agent_end`?**

- If abort fires `agent_end` → idle marker is appended → next launch sees a
  clean tail → no spurious resume. Fine.
- If abort does **not** fire `agent_end` → the disposed session's branch ends on
  a partial message/tool_call → next launch classifies it as "interrupted" and
  **auto-re-triggers a turn the user deliberately abandoned.**

I cannot confirm from the changelog which path pi takes, and I won't guess. This
is the single highest-value thing to verify before trusting the extension on
0.79. It is framed as a *potential* break, not a confirmed one, precisely
because the resolution lives in pi's abort path, not the delta text.

Note this is a sharpening of a pre-existing design edge (the extension already
could not distinguish "intentional Ctrl-C + quit mid-turn" from "crash
mid-turn"); 0.77.0 just makes the clean-abort path the standard, deterministic
one, so the edge is now hit reliably instead of occasionally.

**Fix (only if verification shows `agent_end` does not fire on abort):**
distinguish a clean shutdown from a crash. Two concrete options:

- Hook `session_shutdown` (now reliably emitted on SIGTERM/SIGHUP and on
  quit/new/switch — see no-impact item) and append the `session-idle` marker
  there too, so any *orderly* teardown ends the branch in `session-idle`. Only a
  true crash (no shutdown event) then lacks the marker.
- Or read `session_start`'s `event.reason`. Auto-resume only makes sense for
  `"reload"`/`"resume"` restarts of a session that was running; suppress it for
  other reasons. (Caveat: `event.reason` predates this delta — line ~1049 of the
  upstream CHANGELOG — so it is an *orthogonal* fix, not something the delta
  newly enables.)

---

## Simplifications (with how)

The delta enables **no simplification of the existing logic.** The marker-based
detection is unchanged by anything in 0.77–0.79. Listing the one item I checked
that looked promising but isn't a simplification:

### `ctx.mode` (0.78.1) — optional robustness guard, not a simplification

`ctx.mode` now distinguishes TUI / RPC / JSON / print. The extension currently
auto-fires a `triggerTurn` on *any* resume with a session file, in every mode.
Auto-resurrecting an interrupted turn in `print`/`json` mode (one-shot
automation) is plausibly wrong — the caller asked for a single scripted run, not
a revival of stale work.

**How (if desired):** gate the `session_start` re-trigger on
`ctx.mode === "tui"`. This *adds* a line; it does not remove one. I list it as a
robustness enhancement enabled by the delta, explicitly **not** a simplification,
and only worth doing if you actually run this extension under print/json/rpc.

---

## No-impact summary

The three specially-flagged items, addressed directly:

- **Resume command hint on exit (0.78.0).** *Not in the delta summary doc* —
  it's in the upstream CHANGELOG under 0.78.0 but was dropped from
  `pi-0.76-to-0.79-changelog-delta.md`. **No impact.** It is a cosmetic TUI
  message printed on exit suggesting a manual `--resume`. It changes no entries,
  events, or markers. It does **not** make this extension redundant: the hint is
  a manual convenience, while the extension performs *automatic* re-triggering
  of an interrupted turn. Different mechanisms, different intent.
- **`--name` / `-n` session naming (0.78.0).** **No impact.** The extension
  neither reads nor sets the session display name. Naming does not affect
  `getSessionFile()`, the entry stream, or the idle/resume markers. `debug.ts`
  logs `getHeader()` (which may now carry a name) but only prints it.
- **Ephemeral `/new` fix (0.79.1).** **No impact — and mildly favorable.** The
  fix keeps `/new`-from-ephemeral sessions ephemeral (no session file) instead
  of persisting them. The extension already short-circuits `session_start` when
  `!getSessionFile()`, so more sessions correctly staying ephemeral simply means
  more sessions correctly skipped for resume. The `agent_end` handler still
  appends `session-idle` unconditionally, but for an ephemeral session that
  entry is never persisted and never consulted (resume detection only runs for
  filed sessions). No break, no change needed. The guard was already robust.

Everything else in the delta is irrelevant to this extension:

- `ctx.isProjectTrusted()`, `project_trust` event, `defaultProjectTrust` — trust
  machinery; extension does no trust logic. No impact.
- Autocomplete trigger characters — extension registers no autocomplete. No impact.
- `areExperimentalFeaturesEnabled` — extension uses no experimental guards. No impact.
- Prompt template default positional args — extension ships no prompt templates. No impact.
- Exported RPC UI request/response types — extension has no RPC UI. No impact.
- Exported asset path helpers — unused. No impact.
- `ctx.getSystemPromptOptions()` — extension does not inspect the system prompt. No impact.
- Exported `convertToPng`, `parseArgs`/`Args` — unused. No impact.
- OSC 8 `file://` hyperlinks in file-tool titles — extension uses no file tool. No impact.
- `--exclude-tools` / `-xt` — orthogonal CLI flag. No impact.
- `InputEvent.streamingBehavior` — extension handles no input events. No impact.
- `pi.getAllTools()` exposes `promptGuidelines` — extension enumerates no tools. No impact.
- **SIGTERM/SIGHUP run `session_shutdown` (0.77.0)** — extension does not (yet)
  hook `session_shutdown`. No impact on current logic. *Relevant only as the
  mechanism for the optional Break-#1 fix*: it means a `session_shutdown` hook
  would now reliably fire on signal-driven teardown, making "append idle marker
  on orderly shutdown" viable.
- **Follow-ups queued by `agent_end` handlers drain before idle (0.77.0)** — No
  impact. The extension's `agent_end` handler only calls `appendEntry`; it
  queues no follow-up. The resume `sendMessage(triggerTurn:true)` happens in
  `session_start`, which this fix does not touch.
- API key/header config resolution (0.77.0) — no config in extension. No impact.
- Temp extension install path `~/.pi/agent/tmp/extensions` (0.78.1) — install
  plumbing. No impact.
- SDK `createAgentSession()` tolerates missing `package.json` (0.78.1) — SDK
  embedding path; not how this extension loads. No impact.
- `httpIdleTimeoutMs` applies to all providers (0.78.1) — networking. No impact.
- **Package exports: stale `./hooks` subpath removed (0.79.0)** — checked
  specifically: `index.ts` and `debug.ts` import `ExtensionAPI` from the package
  **root**, not `/hooks`. No impact.
- All inherited provider/model fixes (Claude Fable 5, Opus 4.8, Azure, MiniMax,
  NIM, thinking-off compatibility, etc.) — no impact.
