---
description: Introduction to this package and setup walkthrough
---

# Package Onboarding

This is **alenna-pi**, a personal [pi coding agent](https://github.com/badlogic/pi-mono) package. It extends pi with custom workflow skills, a cloud provider, and reusable components.

## What's Included

- **Workflow pipeline** — a structured development flow: brainstorm → architect → plan → implement → review → cleanup. Each phase is a skill that produces artifacts consumed by the next. Invoke with `/workflow`.
- **Azure AI Foundry provider** — auto-discovers model deployments from Azure AI Foundry and registers them as pi models with dynamic Azure AD token refresh.
- **Standalone skills** — `codemap` (generate/refresh a codebase map) and `debugging` (structured root-cause investigation).
- **Subagent orchestration** — spawn groups of specialized agents with channel-based inter-agent communication. Agents run as isolated `pi --mode rpc` processes with topology enforcement, deadlock detection, and a live TUI widget. Tools: `subagent`, `fork`, `send`, `respond`, `check_status`, `teardown`, `await_agents`.
- **Agent definitions** — reusable specialist agents distributed with the package. Currently includes `scout` — a read-only codebase lookup agent that runs on a cheap model for lightweight, mechanical exploration (locating definitions, finding usage sites, grepping for patterns). Always returns file paths with line ranges so the parent reads only what matters.
- **TUI components** — reusable UI primitives like `numbered-select` (keyboard-driven select dialog with inline annotation).

## Behavioral Conventions

This package recommends a behavioral convention — a rule that shapes how the agent works. It needs to be installed into your `AGENTS.md` to take effect.

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

**Would you like me to install this into your `AGENTS.md`?** I can append it to either:

1. **Project-level** — your project's `AGENTS.md` (applies to this repo only)
2. **Global** — `~/.pi/agent/AGENTS.md` (applies to all pi sessions)

Which would you prefer?
