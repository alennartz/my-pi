# Persona Workspaces

**Date:** 2026-10-06 · **Status:** direction agreed, ready for architecting

## The Idea

Let a specialist agent definition initialize the *root* session, not just subagents — "interactive specialist workspaces": cd into a directory, launch pi, and the session *is* the specialist from the first message. Two parts:

1. **Root-session init** — ambient detection of a specialist persona declared by the working directory's AGENTS.md.
2. **Persona replacement everywhere** — specialist definitions replace pi's persona (preamble) instead of appending to it, for subagents in all contexts, not just workspaces.

Grounding fact (verified against pi source): pi's structured system prompt keeps the persona in the `preamble` section alone ("You are an expert coding assistant operating inside pi…"); rules, tools docs, skills, docs, project context, and cwd are separate sections. Replacing the preamble swaps identity only. Extensions can override `systemPromptOptions.sections` (and selected tools) in `before_agent_start` — **no pi core changes needed**.

## Key Decisions

- **Ambient detection over CLI flag or config.** The directory *is* the agent. A flag (`pi --agent scout`) and a project-config default were considered and rejected — booting in the directory is the whole interaction.
- **Full definition inline in AGENTS.md** — front matter carries the specialist shape, body *is* the persona. Self-contained workspace. Not part of subagent discovery (wrong directory for the four-tier walk); root-native only. A reference-style marker (`agent: scout` resolving from agents dirs) was rejected as the primary form.
- **Marker key is `kind: persona`.** "Explicit marker" beats shape-sniffing (`name`+`description` presence) because site-generator front matter could false-positive a persona hijack. `agent` was rejected as the key — too overloaded. `kind:` stays open for future values.
- **All front-matter fields bind the root session** — tools filter, model pin, skills, not just the persona body. The definition is authored for root semantics, so specialist = identity + attention + model.
- **Named agent spawned into a persona cwd: directory wins, visibly.** The workspace is authoritative; a silent identity swap would leave the orchestrator believing it deployed `scout` when it didn't. The override surfaces a notice.
- **Workspace is total at its cwd.** Root sessions, default children, and named children all wear the persona while their cwd is the workspace. Children spawned with another cwd leave it behind. Detection is **strict — the cwd's own AGENTS.md only**: no ancestor walk, subdirectories are plain directories. (Tighter than mirroring pi's context-file walk; chosen for simplicity of reasoning — the persona is exactly one directory deep.)
- **Always-on, no trust gating, no escape hatch.** Boot notice names the persona and source file so takeover is never silent; visibility was chosen over gating. No `--no-persona` flag — wanting a general session means not booting in a persona directory. An explicit `--system-prompt` launch flag still beats the ambient file (your own argument outranks the directory).
- **Specialist subagents get preamble replacement everywhere.** Today the spawn path injects bodies via `--append-system-prompt`, stacking the generic persona under the specialist identity — the confusion this design removes. Specialist bodies become the preamble in all contexts.

## Direction

A my-pi extension (plus a change to the subagents spawn path) hooks `before_agent_start`:

- If the cwd's AGENTS.md front matter has `kind: persona`, override `sections.preamble` with the body and apply the front-matter tools/model/skills to the session. Emit the boot notice.
- When spawning a named specialist whose cwd is a persona workspace, emit the override notice and let the workspace persona win.
- For named specialists spawned anywhere, replace the preamble with the definition body instead of appending.

## Open Questions

**Sharp (inputs to architecting):**

- Spawn-path mechanics for named specialists: pass `--system-prompt <body>` from the subagents extension vs. a child-side `before_agent_start` section override.
- How tools/model/skills binding lands at root — `before_agent_start` exposes selected-tools mutation; boot-time model switching feasibility unverified.
- Where boot/override notices surface (TUI statusline/banner, pimote card).

**Fog:**

- Resume/compaction behavior when the workspace AGENTS.md changes mid-session (transcript replay presumably holds the old persona — acceptable?).
- What future `kind:` values might exist; the seam is deliberately open.
