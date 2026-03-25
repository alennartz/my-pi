---
description: Introduction to this package and setup walkthrough
---

# Package Onboarding

This is **alenna-pi**, a personal [pi coding agent](https://github.com/badlogic/pi-mono) package. It extends pi with custom workflow skills, a cloud provider, and reusable components.

## What's Included

- **Workflow pipeline** — a structured development flow: brainstorm → architect → plan → implement → review → cleanup. Each phase is a skill that produces artifacts consumed by the next. Invoke with `/workflow`.
- **Azure AI Foundry provider** — auto-discovers model deployments from Azure AI Foundry and registers them as pi models with dynamic Azure AD token refresh.
- **Standalone skills** — `codemap` (generate/refresh a codebase map) and `debugging` (structured root-cause investigation).
- **Subagent orchestration** — spawn groups of specialized agents with channel-based inter-agent communication. Agents run as isolated `pi --mode rpc` processes with topology enforcement, deadlock detection, and a live TUI widget. Tools: `subagent`, `send`, `respond`, `check_status`, `teardown_group`.
- **Agent definitions** — reusable specialist agents distributed with the package. Currently includes `scout` — a read-only codebase lookup agent that runs on a cheap model for lightweight, mechanical exploration (locating definitions, finding usage sites, grepping for patterns). Always returns file paths with line ranges so the parent reads only what matters.
- **TUI components** — reusable UI primitives like `numbered-select` (keyboard-driven select dialog with inline annotation).

## Behavioral Conventions

This package recommends a behavioral convention — a rule that shapes how the agent works. It needs to be installed into your `AGENTS.md` to take effect.

> **Pause at the Explore→Act Boundary** — On the first explore→act transition in a conversation, or after significant discussion since the last action phase, stop and present what you're about to do in ~200–300 word chunks. Wait for feedback before proceeding. Skip the pause during short, rapid back-and-forth — it would just slow things down.

**Would you like me to install this into your `AGENTS.md`?** I can append it to either:

1. **Project-level** — your project's `AGENTS.md` (applies to this repo only)
2. **Global** — `~/.pi/agent/AGENTS.md` (applies to all pi sessions)

Which would you prefer?
