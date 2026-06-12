# pi 0.76→0.79 delta analysis: `extensions/worktree/`

What the extension does, in brief: registers a `/worktree create|cleanup` slash
command. `create` makes a git worktree under `~/.git-worktrees/<repo>/<branch>`,
creates/forks/continues a session for that path, and **switches the runtime into
it** (`ctx.switchSession`). `cleanup` drives an agent merge turn (via
`pi.sendUserMessage` + an `agent_start`/`agent_end` barrier), verifies the merge
landed, removes the worktree/branch, then forks the session back into the main
worktree and switches there. It uses `execSync` git calls, in-memory waiter
arrays, and `ctx.ui.select`/`notify`. No sockets, timers, or other long-lived
resources.

---

## Breaks (with fix)

### 1. cwd-switch project-trust prompts now fire on every worktree switch — `project_trust` (0.79.0) + `ctx.isProjectTrusted()` (0.79.1)

The delta states the `project_trust` event fires at **"startup + cwd switch."**
The entire purpose of this extension is to switch cwd — `ctx.switchSession()`
lands the runtime in a brand-new directory under `~/.git-worktrees/<repo>/<branch>`
that pi has never seen. With `defaultProjectTrust: ask` (the new global default
knob), the user gets a **trust prompt every time they run `/worktree create`**,
because the worktree lives outside the original project root and is therefore an
untrusted directory from pi's point of view.

This is a genuine behavior change, not a hypothetical: before this range there was
no cwd-switch trust gate; now there is. It degrades the core flow — what used to
be "create worktree → land in it" becomes "create worktree → answer a trust
prompt → land in it," and the `cleanup` switch-back to the main worktree may
prompt too (though the main root is more likely already trusted).

Skeptical caveat: the prompt only appears when `defaultProjectTrust` is `ask` and
the target path isn't already remembered. A user who runs `always` never sees it.
But `ask` is the surface the delta calls out as the new default-capable behavior,
so the extension should not assume trust.

**Fix:** register a `project_trust` handler that auto-trusts paths the extension
itself created. A worktree under `~/.git-worktrees/<repo>/…` is a checkout of an
already-trusted repo — there is no new code being introduced that wasn't already
trusted at the main worktree. Something like:

```ts
pi.on("project_trust", (ev) => {
  // ev.path (shape TBD — verify against the 0.79 event payload)
  if (isUnderWorktreeRoot(ev.path)) return /* trust */;
  // otherwise defer to pi's normal decision
});
```

Verify the exact event name/payload and the expected return contract against the
installed `@earendil-works/pi-coding-agent` 0.79 typings before relying on this —
the delta describes the capability but not the signature. `ctx.isProjectTrusted()`
is the read-side companion: the handler (or `create`) could short-circuit when the
path is already trusted. This same change is also listed under Simplifications
because it is net-new capability, but it earns a Breaks entry because *not* doing
it leaves the extension with a worse UX than it had at 0.76.

---

## Simplifications (with how)

### 1. Auto-trust worktree paths via `project_trust` (0.79.0) / `ctx.isProjectTrusted()` (0.79.1)

Same change as Breaks #1, viewed as an enhancement: the extension knows it only
ever switches into directories it just created from a trusted repo, so it is the
ideal authority to declare those paths trusted. Registering one `project_trust`
handler removes the trust prompt from the create/cleanup flows entirely. **How:**
`pi.on("project_trust", …)` returning a trust decision for paths under
`WORKTREE_ROOT_DIRECTORY_NAME` for the active repo; fall through otherwise.

### 2. Refuse non-interactive modes early via `ctx.mode` (0.78.1)

The command handler unconditionally calls `ctx.ui.select(...)`
(`chooseContextTransfer`, `choosePendingChanges`). In `print`/`json`/`rpc` mode
there is no human to answer a `select`, so the command can hang or fail opaquely.
**How:** at the top of the `handler`, if `ctx.mode !== "tui"`, `ctx.ui.notify(...)`
a clear "this command is interactive-only" message and return. This is a small
robustness win, not a behavior the extension currently gets right. Verify the
exact `ctx.mode` value strings against the 0.78.1 typings.

### 3. (Marginal) `parseArgs` / `Args` exports (0.78.0)

`command-surface.ts` hand-rolls positional parsing (`args.trim().split(/\s+/)`).
The new exported `parseArgs` is flag-oriented; the worktree surface is purely
positional (`create <branch> [base]`, `cleanup [target]`). Adopting it would add
a dependency without removing meaningful code. **Recommendation: skip** — listed
only for completeness. No action.

---

## No-impact summary

Concrete reasons each remaining delta item does not touch this extension:

- **`--name` / `-n` session display name (0.78.0)** — flagged for attention, but
  it is a **process-startup CLI flag**, not a `SessionManager` API. This extension
  creates sessions programmatically (`SessionManager.create`/`forkFrom`/
  `continueRecent`) and switches in-process; the startup flag never runs in its
  path. The delta adds **no** session-naming parameter to `SessionManager`, so
  there is nothing to call. Naming worktree sessions after their branch would be a
  nice UX win, but this delta does not enable it. **No impact** (revisit if a
  `SessionManager` naming API later appears).

- **Session disposal aborts in-flight work (0.77.0)** — flagged for attention. The
  extension's design already avoids the hazard: `switchSession` (which disposes the
  old session) runs only from a slash-command handler while the agent is idle, and
  the `cleanup` path explicitly **awaits the merge turn to fully end** (via the
  `agent_start`/`agent_end` barrier in `sendUserMessageAndAwaitTurn`) before
  forking + switching. So there is no in-flight agent/bash/compaction work to abort
  at disposal time. The new abort-on-disposal behavior is consistent with — and
  mildly reassuring for — the existing "wait for turn end, then switch" ordering.
  **No code change; no break.**

- **SIGTERM/SIGHUP run `session_shutdown` (0.77.0)** — flagged for attention. The
  extension holds **no releasable resources**: git calls are synchronous
  (`execSync`, fully drained before return), and its only state is in-memory waiter
  arrays plus on-disk session files written eagerly. It registers no
  `session_shutdown` handler and needs none. Note one *unchanged* pre-existing risk
  this fix does **not** solve: a SIGTERM between `stashPush` and `addWorktree` could
  orphan a stash — but that is a synchronous window, not something a shutdown hook
  cleanly recovers. **No impact.**

- **Follow-ups queued by `agent_end` handlers drain before idle (0.77.0)** — the
  extension's `agent_end` handler only resolves pending promise waiters; it does
  **not** queue follow-up user messages. The cleanup continuation (fork + switch)
  resumes as a normal async continuation of the awaiting handler, not as an
  `agent_end`-queued follow-up. **No impact.**

- **Autocomplete trigger characters (0.79.1)** — applies to
  `ctx.ui.addAutocompleteProvider()`. The extension uses command-scoped
  `getArgumentCompletions` on its registered `/worktree` command, not a global
  autocomplete provider. **No impact.**

- **Package exports: stale `./hooks` subpath removed (0.79.0)** — the extension
  imports only from `@earendil-works/pi-coding-agent` (root) and
  `@earendil-works/pi-tui`. No `/hooks` import exists. **No impact.**

- **SDK `createAgentSession()` tolerates missing `package.json` (0.78.1)** — the
  extension uses `SessionManager.*`, not `createAgentSession`. Its `create()`
  bootstrap-entry workaround (forcing the session file to disk so the persisted
  header records `cwd`) is unrelated to this fix. **No impact.**

- **`InputEvent.streamingBehavior` (0.77.0)** — distinguishes idle/steer/queued
  prompts on `InputEvent`. The extension's barrier keys off `agent_start`/
  `agent_end`, not input classification, and its precondition ("must run while
  agent idle") is enforced by the `agentRunning` guard. **No impact.**

- **`pi.getAllTools()` exposes `promptGuidelines` (0.77.0)** — extension does not
  enumerate tools. **No impact.**

- **`--exclude-tools` / `-xt` (0.77.0)** — startup tool-disabling flag; extension
  registers a command and does not introspect the tool set. **No impact.**

- **`defaultProjectTrust` setting (0.79.1)** — a global user setting, not an
  extension API; it is the *cause* of Breaks #1's prompt, but the extension cannot
  and should not read/write it. Mitigation lives in the `project_trust` handler.
  **No direct impact** (its consequence is handled under Breaks #1).

- **`areExperimentalFeaturesEnabled` (0.79.1)**, **prompt-template default
  positional args (0.79.1)**, **exported RPC UI request/response types (0.79.0)**,
  **exported asset-path helpers (0.79.0)**, **`ctx.getSystemPromptOptions()`
  (0.78.1)**, **exported `convertToPng` (0.78.0)**, **OSC 8 `file://` hyperlinks in
  built-in file tool titles (0.78.0)**, **`~/.pi/agent/tmp/extensions` install path
  (0.78.1)**, **`httpIdleTimeoutMs` all-providers (0.78.1)**, **API key/header
  config resolution (0.77.0)** — none touch the extension's feature set (git
  worktrees, session create/fork/switch, slash-command UI). **No impact.**

- **All inherited provider/model fixes** (Claude Fable 5, Opus 4.8, Azure OpenAI
  Responses, GPT-5.x context windows, MiniMax-M3, Ant Ling, NVIDIA NIM, z.ai/Kimi/
  OpenRouter reasoning-effort) — model-runtime concerns; the extension is
  provider-agnostic. **No impact.**
