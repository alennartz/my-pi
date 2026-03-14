---
description: Introduction to this package and setup walkthrough
---

# Package Onboarding

This is **alenna-pi**, a personal [pi coding agent](https://github.com/badlogic/pi-mono) package. It extends pi with custom workflow skills, a cloud provider, and reusable components.

## What's Included

- **Workflow pipeline** — a structured development flow: brainstorm → architect → plan → implement → review → cleanup. Each phase is a skill that produces artifacts consumed by the next. Invoke with `/workflow`.
- **Azure AI Foundry provider** — auto-discovers model deployments from Azure AI Foundry and registers them as pi models with dynamic Azure AD token refresh.
- **Standalone skills** — `codemap` (generate/refresh a codebase map) and `debugging` (structured root-cause investigation).
- **TUI components** — reusable UI primitives like `numbered-select` (keyboard-driven select dialog with inline annotation).

## Behavioral Conventions (`SYSTEM.md`)

This package includes a `SYSTEM.md` file containing behavioral conventions — rules that shape how the agent works. These aren't loaded automatically; they need to be installed into your `AGENTS.md`.

Currently there's one convention:

> **Pause at the Explore→Act Boundary** — When transitioning from an exploratory phase (brainstorming, investigating, diagnosing, planning) to an action phase (writing files, running commands, editing code), stop and present what you're about to do in ~200–300 word chunks. Wait for feedback before proceeding. Applies everywhere: workflow transitions, debugging fix proposals, mid-task course changes.

Here's the full content to install:

```markdown
## Pause at the Explore→Act Boundary

When you transition from an exploratory phase (brainstorming, investigating, diagnosing, planning) to an action phase (writing files, running commands, editing code), **stop and present what you're about to do before doing it.**

- Break your proposed actions into digestible chunks of ~200–300 words each.
- Present one chunk at a time — describe the change, why you're making it, and what it affects.
- Wait for user feedback before moving to the next chunk or proceeding with execution.

This applies everywhere: workflow skill transitions (e.g., moving from architecting into implementation), debugging fix proposals, mid-task course changes, or any moment where you shift from "building understanding" to "doing things." The boundary between exploring and acting always deserves a pause.
```

**Would you like me to install this into your `AGENTS.md`?** I can append it to either:

1. **Project-level** — your project's `AGENTS.md` (applies to this repo only)
2. **Global** — `~/.pi/agent/AGENTS.md` (applies to all pi sessions)

Which would you prefer?
