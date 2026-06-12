# pi 0.76→0.79 delta analysis: `extensions/subagents/`

Scope: the subagents extension spawns and coordinates child `pi --mode rpc`
processes over a Unix-socket broker. It holds three classes of OS resources —
a broker `net.Server` + socket file, broker client sockets, and child
`ChildProcess` handles — and it relies on `session_shutdown` to release them.
That makes the 0.77 lifecycle/signal fixes the centre of gravity here.

---

## Breaks (with fix)

### 1. Latent leak now fixed by pi — no code change, but verify the timing budget

**Item:** *SIGTERM/SIGHUP run `session_shutdown`; SIGHUP no longer hard-exits (0.77.0).*

This is the most consequential item. The extension's `session_shutdown` handler
(`index.ts:1303`) already does the right thing: `manager.softShutdown()` SIGTERMs
every child, stops the broker, unlinks the socket file, and disconnects both
broker clients. The handler's own comment was written for the jiti-reload case.

Before 0.77, signal-triggered shutdown (terminal closed → SIGHUP, or `kill`
→ SIGTERM) did **not** run `session_shutdown`. The practical consequence for
*this* extension was a real leak the handler was never given the chance to
prevent:

- the broker socket file in `os.tmpdir()` was left on disk, and
- **child `pi` processes were orphaned and kept running** (they only die when
  the dead module's `ChildProcess` refs are GC-finalized — which never happens
  if the process is exiting).

0.77 closes this automatically. No code change required — the existing handler
now fires in the scenarios it was always meant to cover.

**But two timing assumptions become load-bearing and should be verified:**

1. **`softShutdown` is async and slow.** It does
   `await Promise.all(entries.map(e => e.rpc.stop()))`, and `rpc.stop()`
   (`rpc-child.ts:181`) sends SIGTERM then waits **up to 5 s per child** before
   SIGKILL. If pi imposes a deadline on `session_shutdown` during *signal*
   shutdown (it must emit "before terminal writes"), a slow/deep tree can be
   force-killed mid-cleanup — re-introducing the orphan problem one level down.
   **Fix/verify:** confirm pi awaits the `session_shutdown` promise without a
   tight deadline on SIGTERM/SIGHUP; if there is a deadline, consider issuing
   SIGTERM to all children up front (fire-and-forget) before awaiting, so the
   whole tree starts dying in parallel rather than serially within the 5 s
   window.

2. **Recursive cascade now works — and that's the point.** A child that is
   itself a parent now runs *its own* `session_shutdown` when the parent SIGTERMs
   it (same pi version, same fix), so it SIGTERMs its grandchildren. Before 0.77
   that inner SIGTERM would not have run `session_shutdown`, orphaning
   grandchildren. This is a genuine fix to deep-tree teardown. It also compounds
   risk (1): each tree level adds up to 5 s of serial wait.

### 2. Session disposal aborting in-flight work — already handled, no break

**Item:** *Session disposal aborts in-flight agent/compaction/branch/retry/bash
work (0.77.0).*

The extension's only long-lived tool executes are the blocking ones:
`await_agents`, `send` with `expectResponse`, and `subagent`/`fork` with
`await: true`. All of them already thread the `AbortSignal`:

- `send` checks `signal?.aborted` and races the blocking wait against `abort`
  (`index.ts:867,905`), cancelling the correlation waiter on abort.
- `awaitAgentCompletion` registers an `abort` listener and rejects with
  "Wait cancelled" (`index.ts:297`), used by `await_agents`, `subagent`, `fork`.

So when disposal now aborts these tool calls, they unwind cleanly instead of
hanging the disposal. This is an improvement the code is already shaped for —
**no break.** (`respond`, `check_status`, `teardown`, `interrupt` are
short-lived and don't need the signal.)

### 3. Risk to verify: project-trust gating for cwd-override children

**Items:** *`project_trust` event, `defaultProjectTrust` setting,
`ctx.isProjectTrusted()` (0.79).*

The `cwd` override on `subagent` boots a child "as if pi were freshly launched
in this directory," discovering that directory's AGENTS.md / project agents /
project skills (`index.ts` AgentItem `cwd` description). With 0.79's project-trust
machinery, a child launched in a *different, untrusted* project directory may
now hit a trust decision before project-local resources load. The child runs in
`--mode rpc` with no interactive human, and the extension passes no trust flag.

**Verify:** does an RPC-mode child in an untrusted cwd (a) silently skip
project resources, (b) inherit `defaultProjectTrust`, or (c) block/hang waiting
for a trust answer it can never get? If (c), cwd-override spawns into untrusted
dirs would stall at boot — a real break introduced by the new gating. If pi
exposes a startup flag or the `defaultProjectTrust: always`/`never` setting
covers RPC mode, document the expected behavior; otherwise the extension may
need to pass an explicit trust decision when spawning. This is a *flag to
confirm*, not a confirmed break.

---

## Simplifications (with how)

### 1. `ctx.mode` replaces the `ui.custom()` TUI-probe hack

**Item:** *`ctx.mode` distinguishes TUI / RPC / JSON / print (0.78.1).*

`ensureWidget` (`index.ts:550`) currently detects TUI-vs-headless by *probing*:
it calls `ctx.ui.custom(...)` with a self-completing overlay and checks whether
the return value is `undefined` (RPC mode resolves to `undefined`, TUI resolves
to the value). That's a deliberate hack to work around the absence of a mode
signal.

**How:** replace the probe with `ctx.mode === "tui"`. The block becomes:

```ts
if (ctx.mode === "tui") { ctx.ui.setWidget(...) } else { panelHandle = detect(...) }
```

This removes a speculative overlay render and an `await` from the hot spawn
path, and states intent directly. (Children always run `--mode rpc` and
`ensureWidget` already early-returns on `parentLink`, so only the root agent's
detection is affected — exactly where `ctx.mode` is authoritative.)

### 2. `--name` gives children identifiable session display names

**Item:** *`--name` / `-n` startup session display name across TUI/print/JSON/RPC
(0.78.0).*

Children are spawned anonymously today (`buildAgentArgs`/`buildForkArgs` in
`agents.ts` never set a name). Their session files and any process listing
(`pi-ps`) show no logical identity.

**How:** append `--name <agentId>` (or `<agentId> · <agentDef>`) in
`buildAgentArgs`/`buildForkArgs`. Pure observability win — makes child sessions
greppable and `pi-ps` output legible during multi-agent runs. No behavioral
dependency; safe to add.

### 3. (Marginal) exported RPC types for `rpc-child.ts`

**Item:** *Exported RPC extension UI request/response types (0.79.0).*

`rpc-child.ts` speaks the RPC protocol entirely through `any` (`get_state`,
`prompt`, `abort` commands; `response`/event parsing). Typed RPC definitions
would harden it. **Caveat / skeptical read:** the delta specifically exports
*UI* request/response types (for an extension inside an RPC pi making UI calls
back to its controller). `RpcChild` consumes the *core* command/event protocol
(prompt/abort/get_state, agent_start, message_end, tool_execution_*, agent_end),
which these UI types likely do **not** cover. So this is at best a partial win
and may not apply at all — confirm what the exported types actually describe
before counting on them. Low priority.

### 4. (Reinforcement, not a change) `agent_end` follow-up draining

**Item:** *Follow-ups queued by `agent_end` handlers drain before idle (0.77.0).*

The extension's `agent_end` handler calls `queue.setParentBusy(false)`
(`index.ts`), which flushes the NotificationQueue via `pi.sendMessage(..., {
triggerTurn: true })`. That is precisely "a follow-up queued from an `agent_end`
handler." This is the fallback path documented in the `USE_STEER_DELIVERY`
comment ("agent_end remains as a fallback for notifications that arrive while
the LLM is streaming"). 0.77 *guarantees* such follow-ups drain before the
parent goes idle, removing a latency/race the fallback previously depended on
implicitly. **No code change** — the fix strengthens an assumption the extension
already makes. Worth knowing the fallback is now reliable rather than
best-effort.

---

## No-impact summary

Concretely checked and ruled out:

- **`InputEvent.streamingBehavior` (0.77.0):** the extension registers no input
  handler and reads no `InputEvent`. (`rpc-child.ts:165` *sends* a
  `streamingBehavior` field on the RPC `prompt` command — unrelated to the
  parent-side `InputEvent` field, and currently unused for task prompts anyway.)
  No impact.
- **Exported package asset path helpers (0.79.0):** extension references no
  bundled pi package assets; `discoverPackageAgents` already resolves package
  baseDirs via `DefaultPackageManager`. No impact.
- **`ctx.getSystemPromptOptions()` (0.78.1):** the extension *appends* to the
  system prompt in `before_agent_start`; it never needs to inspect the base
  prompt inputs. No impact.
- **`--exclude-tools` / `-xt` (0.77.0):** tool gating here is allowlist-based
  (agent `tools` frontmatter → `--tools` for builtins, plus `PI_PARENT_LINK.tools`
  + `shouldRegisterTool` for the extension's own 8 tools). A denylist flag
  doesn't cleanly replace either mechanism. No meaningful simplification.
- **`pi.getAllTools()` exposes `promptGuidelines` (0.77.0):** the extension
  *sets* `promptGuidelines`; it doesn't consume `getAllTools()`. No impact.
- **Package exports: stale `./hooks` subpath removed (0.79.0):** no import from
  any `/hooks` subpath (imports are the package root, pi-ai, pi-tui,
  @pimote/panels, typebox). No impact.
- **API key/header config resolution (0.77.0):** extension resolves no API keys
  or headers. No impact.
- **Temp extension installs → `~/.pi/agent/tmp/extensions` (0.78.1):** internal
  to pi's installer. No impact.
- **SDK `createAgentSession()` tolerates missing `package.json` (0.78.1):** the
  extension spawns the `pi` CLI, never the SDK session factory. No impact.
- **`httpIdleTimeoutMs` all providers (0.78.1):** no impact.
- **Autocomplete trigger chars, `areExperimentalFeaturesEnabled`, prompt-template
  default positional args, OSC 8 file hyperlinks, `convertToPng`, `parseArgs` /
  `Args` (0.77–0.79):** none used by this extension. No impact.
- **Inherited provider/model fixes (Fable 5, Opus 4.8, Azure, MiniMax, NIM,
  thinking-off compat):** automatic via the pi-ai bump; the extension is
  model-agnostic and resolves model ids through `ctx.modelRegistry`. No impact.
- **`--name` for the *root* agent, project-trust *settings* UI:** see
  Simplification 2 / Break 3 — only the child-spawn and cwd-override paths are
  relevant.
