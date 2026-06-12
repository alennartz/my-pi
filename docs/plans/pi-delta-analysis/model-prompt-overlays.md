# pi 0.76→0.79 delta analysis: `model-prompt-overlays`

## What the extension does (assumptions it relies on)

- Hooks `before_agent_start`.
- Reads the active model id from `ctx.model?.id`.
- Runs its **own** filesystem walk (`discoverContextRoots`: global agent dir +
  every ancestor dir from `/` down to `ctx.cwd`) and loads `AGENTS.*.md` overlay
  files via `readdirSync`/`readFileSync` + `parseFrontmatter`.
- Matches each overlay's `models` globs against the model id, sorts, renders a block.
- Returns `{ systemPrompt: event.systemPrompt + "\n\n" + block }`.

Critically: the extension does **not** reconstruct pi's system-prompt inputs. It
builds an independent overlay-file discovery and appends to the already-assembled
`event.systemPrompt`. This framing matters for the simplification question below.

## Breaks (with fix)

### Project-local overlays are injected with no trust gate

**Genuinely applies — latent gap that the 0.79 trust APIs both expose and let you close.**

The ancestor walk in `discovery.ts` deliberately includes project-local and
ancestor directories ("this walk does not require an AGENTS.md / CLAUDE.md
anchor — overlays are discovered on their own"). Any `AGENTS.*.md` found in an
untrusted project dir has its body spliced directly into the system prompt.

The 0.79.0 `project_trust` event is described as firing "before project-local
resources load," and 0.79.1 adds `ctx.isProjectTrusted()`. That establishes a pi
expectation: project-local resources (the category these overlay files fall into)
should not load until the project is trusted. This extension bypasses that gate —
it reads and injects project-local instruction text unconditionally. With the new
trust model in place, the extension's "every discovered overlay is safe to inject"
assumption is now inconsistent with how pi treats project-local resources.

`before_agent_start` fires on prompt submit, by which point trust has already been
decided, so `ctx.isProjectTrusted()` is reliable at the call site.

**Fix:** gate project-local roots (the ancestor-walk roots, i.e. everything except
the global agent dir at `rootIndex` 0) behind `ctx.isProjectTrusted()`. When the
project is untrusted, load overlays only from the global agent dir and skip the
ancestor roots. The global agent dir is user-owned and should remain unconditional.

This is the only delta item that touches a real assumption. Severity is "should
fix for consistency with pi's trust model," not "extension is broken today."

## Simplifications (with how)

### `ctx.getSystemPromptOptions()` / `event.systemPromptOptions` — **does not apply**

The parent flagged these as a way to "stop reconstructing system-prompt inputs by
hand." Skeptical conclusion: they do not help this extension, because it never
reconstructs system-prompt inputs.

- `BuildSystemPromptOptions.contextFiles` holds the context files **pi loaded**
  (AGENTS.md / CLAUDE.md anchors). The overlay files this extension cares about
  (`AGENTS.*.md`) are exactly the files pi does *not* load — that is the extension's
  entire reason to exist. So `contextFiles` will never contain them; it cannot
  replace `loadOverlayFiles`/`discoverContextRoots`.
- Using the *directories* of `contextFiles` to seed the walk would be a behavior
  **change**, not a simplification: the extension intentionally walks every ancestor
  dir regardless of whether an AGENTS.md anchor exists there. Deriving roots from
  loaded context files would narrow discovery to anchored dirs only.
- `systemPromptOptions.cwd` duplicates `ctx.cwd`, which the extension already uses.
- The extension already obtains the assembled prompt from `event.systemPrompt`; it
  has no need to inspect the structured options to do its append.

No code change. (If anything is adopted, prefer the already-present
`event.systemPromptOptions` over `ctx.getSystemPromptOptions()` inside the handler —
but there is no reason to adopt either.)

### `ctx.mode` — **does not apply**

`ctx.mode` (`tui`/`rpc`/`json`/`print`) lets an extension branch by run mode. This
extension's behavior is mode-independent by design — a model-specific prompt overlay
should apply identically whether pi runs interactively or in print/JSON mode. There
is no existing mode-dependent code to simplify and no correctness reason to add one.
The only mode coupling today is `ctx.ui.notify` for diagnostics, which is already a
no-op-safe UI call; no change warranted.

## No-impact summary

None of the following touch this extension's surface (it has no sockets, no
streaming/input hooks, no provider/env config, no tool registration, no custom UI
components beyond `notify`):

- **Session disposal aborts in-flight work / SIGTERM-SIGHUP `session_shutdown` /
  follow-ups drain before idle** — the extension does no async work, holds no
  resources, and registers no shutdown handler.
- **API key / header `$ENV_VAR` resolution** — extension reads no provider config.
- **Temp extension install dir `~/.pi/agent/tmp/extensions`** — install plumbing only.
- **`createAgentSession()` tolerates missing `package.json` / `httpIdleTimeoutMs` /
  stale `./hooks` export removal** — unused by this extension.
- **`--exclude-tools`, `pi.getAllTools().promptGuidelines`,
  `InputEvent.streamingBehavior`, autocomplete trigger chars, prompt-template
  default args, `areExperimentalFeaturesEnabled`, exported RPC UI types, exported
  asset-path helpers, `convertToPng`, `parseArgs`/`Args`, `--name`, OSC 8 file
  hyperlinks** — none are referenced or relevant.
- **Provider/model additions (Claude Fable 5, Opus 4.8, Azure GPT-5.4/5.5 windows,
  MiniMax-M3, etc.)** — these introduce new model ids that users' overlay `models`
  globs can now match, but require **zero** code change; matching is glob-driven and
  model-agnostic.

## Bottom line

- One genuine finding: add a `ctx.isProjectTrusted()` gate on the project-local
  (ancestor-walk) roots so untrusted project overlays aren't injected into the
  system prompt, consistent with pi 0.79's trust model. Keep the global agent dir
  unconditional.
- The two APIs the parent highlighted (`getSystemPromptOptions()`, `ctx.mode`) do
  **not** simplify this extension — it discovers its own files rather than
  reconstructing pi's prompt inputs, and its behavior is intentionally
  mode-independent.
- Everything else in the delta is no-impact.
