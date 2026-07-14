---
description: Introduction to this package and setup walkthrough
---

# Package Onboarding

This is **alenna-pi**, a personal [pi coding agent](https://github.com/badlogic/pi-mono) package. It extends pi with custom workflow skills, provider extensions, and reusable components.

## What's Included

- **Workflow pipeline** — a structured development flow: brainstorm → architect → test-write → test-review → impl-plan → implement → review → handle-review → cleanup. Each phase is a skill that produces artifacts consumed by the next. Driven by `/autoflow`: brainstorm and architect are interactive; remaining phases run autonomously via subagents, with transitions validated against bundled artifact checks.
- **Providers and quota enforcement** — Azure AI Foundry auto-discovers model deployments and registers them as pi models with dynamic Azure AD token refresh. Quota-providers framework adds pro-rated soft-cap enforcement, session-scoped bypass, `/quota` command for usage tracking, and footer indicator. Configured at `~/.pi/agent/quota-providers.json`.
- **Standalone skills** — `codemap` (generate/refresh a codebase map) and `debugging` (structured root-cause investigation).
- **Subagent orchestration** — spawn specialized agents with channel-based inter-agent communication. Agents run as isolated `pi --mode rpc` processes with topology enforcement, deadlock detection, persistent per-parent child sessions, append-only lifecycle logging for restore/replay, and a live TUI widget. Tools: `subagent`, `fork`, `send`, `respond`, `check_status`, `teardown`, `resurrect`, `await_agents`.
- **Agent definitions** — reusable specialist agents distributed with the package. Currently includes `scout` — a read-only codebase lookup agent that runs on a cheap model for lightweight, mechanical exploration (locating definitions, finding usage sites, grepping for patterns). Always returns file paths with line ranges so the parent reads only what matters.
- **Git worktree management** — `/worktree create <branch>` and `/worktree cleanup` slash commands for working across git worktrees with automatic pi session handoff. Creates worktrees, transfers conversation context, and cleans up merged branches.
- **Toolscript integration** — spawns toolscript as a long-lived child process and surfaces its MCP tools as pi tools. Config resolution looks for `~/.pi/toolscript/toolscript.toml` (user-level) and `./toolscript.toml` (project-level).
- **User edit tool** — `user_edit` opens a file in pi's built-in editor so the user can manually edit it. Supports existing files and new file creation.
- **TUI components** — reusable UI primitives like `numbered-select` (keyboard-driven select dialog with inline annotation).

## Coding Principles

This package ships a set of general engineering principles in [`conventions/coding-principles.md`](../conventions/coding-principles.md) — a stance on pure functions, deliberate mutation points, globals, closures, naming, and one-function-per-business-operation. Unlike the behavioral conventions below, these are not model-specific overlays; they belong in the base `AGENTS.md`.

Read that file and offer to install its contents into either:

1. **Project-level** — append to this project's `./AGENTS.md` (applies in this repo)
2. **Global** — append to `~/.pi/agent/AGENTS.md` (applies in all sessions)

If the target file already contains a `## Coding Principles (Always Follow)` section, ask before overwriting; otherwise append.

## Behavioral Conventions

This package recommends a behavioral convention — a rule that shapes how the agent works. To keep it Claude-only, install it in an `AGENTS.claude.md` overlay with model frontmatter.

> ---
> models: claude-*
> ---
>
> ## Pause at the Explore→Act Boundary
>
> When you transition from an exploratory phase (brainstorming, investigating, diagnosing, planning) to an action phase (writing files, running commands, editing code), **stop and present what you're about to do before doing it** — but only when the pause adds value:
>
> - **Pause** on the first explore→act transition in a conversation, or after significant discussion (long exploration, multiple topics, complex tradeoffs) since the last action phase.
> - **Don't pause** when the conversation has short, rapid back-and-forth pacing — the user is already engaged and orienting them on what's next would just slow things down.
>
> When you do pause, present one proposed change at a time (~200–300 words) — describe what you'll do, why, and what it affects. Wait for user feedback before presenting the next one.
>
> This applies everywhere: workflow skill transitions, debugging fix proposals, mid-task course changes, or any moment where you shift from "building understanding" to "doing things."

A second convention targets Opus 4.7 specifically, which tends toward verbosity. Install it in an `AGENTS.claude-opus-4-7.md` overlay so it stacks on top of the Claude-wide overlay.

> ---
> models: claude-opus-4-7
> ---
>
> ## Concision — Elements of Style
>
> Channel *The Elements of Style*: omit needless words, prefer the specific to the general, cut throat-clearing and recaps. Short sentences. Active voice. No preamble like "Great question" or "Here's what I'll do"; no closing summaries unless asked.
>
> ## Chunk Large Presentations
>
> When you have a lot to present — a plan with many parts, a long set of findings, several tradeoffs — don't dump it all at once. Break it into logical sections and present one at a time, waiting for the user before moving on. Each chunk should stand on its own and invite a response.

**Would you like me to install these into Claude-specific overlay files?** For each convention I can create or update either:

1. **Project-level** — your project's `AGENTS.claude*.md` (applies in this repo)
2. **Global** — `~/.pi/agent/AGENTS.claude*.md` (applies in all sessions)

Which would you prefer?

## Subagent Model Tier Configuration

The subagents extension maps four named tiers — `cheap`, `medium`, `smart`, `frontier` — to concrete model IDs at spawn time. The mapping lives in `~/.pi/agent/model-tiers.json`. Without it every tier falls back to the session default.

To configure it:

1. Call `list_models` to get the full model catalog with context windows and pricing.
2. Analyze the output. Group models into four tiers by capability and cost:
   - **cheap** — lowest input/output cost; suitable for mechanical work (grepping, scouting, simple lookups). Prefer a small/fast model.
   - **medium** — mid-range cost and capability; solid general-purpose coding and reasoning.
   - **smart** — high capability; use for architecture, complex reasoning, hard debugging. Cost is secondary.
   - **frontier** — the best available model in the catalog, regardless of cost.
3. Propose one model per tier, with a one-sentence rationale for each choice. If a tier is ambiguous (e.g. two models seem equally suited), name both options and ask the user to pick.
4. After the user confirms (or adjusts) the assignments, write `~/.pi/agent/model-tiers.json` with the agreed values.

Example output format:

```json
{
  "cheap": "anthropic/claude-haiku-3-5",
  "medium": "anthropic/claude-sonnet-4-5",
  "smart": "anthropic/claude-opus-4-5",
  "frontier": "anthropic/claude-opus-4-5:xhigh"
}
```

If `~/.pi/agent/model-tiers.json` already exists and is non-empty, show the current assignments alongside your proposals and ask whether to overwrite or keep the existing config.

**Proceed with the model tier configuration now.**
