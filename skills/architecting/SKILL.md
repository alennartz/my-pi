---
name: architecting
description: "Make architectural decisions for a feature or change, grounded in the actual codebase. The first phase of an implementation plan — use after brainstorming or when the direction is already clear."
---

# Architecting

## Overview

Turn a direction into a technical shape. Read the codemap, dive into the relevant code, and make architectural decisions through conversation with the user — one decision at a time, grounded in what the codebase actually looks like today.

The output is the first half of the implementation plan — `docs/plans/<topic>.md`. The execution plan skill later completes it with concrete steps.

Do NOT produce execution steps, specific file changes, or ordered task sequences. The output is architectural decisions — which modules, which patterns, which interfaces, which technology — not a step-by-step build plan.

## Process

### 0. Check for Context

Before starting:

1. **Read `codemap.md`** at the repo root. If it doesn't exist, suggest to the user that one should be created and offer to generate it now using the codemap skill. If the user declines, fall back to an unguided exploration of the codebase — survey the directory structure, entry points, and key files to ground yourself before proceeding.

2. **Check for a brainstorm.** If the user links one, read it from `docs/brainstorms/<topic>.md`. If no brainstorm is linked and the user's description feels too vague or too large in scope, suggest they brainstorm first. If the direction is clear enough, proceed. When a brainstorm exists, pay attention to its structure: **key decisions** (with reasoning) are settled starting points, **open questions** are fair game for discussion. Don't treat them the same.

### 1. Investigate

Identify which modules from the codemap are likely impacted. Read into those modules — entry points, interfaces, key files — to understand the current reality. Don't read everything; read enough to make informed decisions.

Share what you're finding as you go. The user should see your reasoning, not just your conclusions.

### 2. Check Decision Records

Scan `docs/decisions/` for existing decision records. If the directory doesn't exist or is empty, move on.

Read DRs that are relevant to the current work — you now have context from the codemap, any brainstorm, and your code investigation, so you can judge relevance. Skim titles and contexts first; read fully only the ones that touch on modules, patterns, or technology choices involved in this work.

Relevant DRs become **settled context** for the decision conversation in the next step. Note which ones you found and what they cover — the user should see what prior decisions you're working with.

### 3. Decide, One at a Time

Walk through architectural decisions conversationally. Each decision should be grounded in what you found in the code. One decision at a time — don't dump a wall of choices.

**Don't relitigate brainstorm decisions.** If the brainstorm already decided something, don't re-ask about it — start from it. Only revisit a brainstorm decision if your code investigation contradicts the *reasoning* behind it. The brainstorm captures *why* each decision was made; that's your anchor. If the reasons still hold, the decision still holds. If you found something that undermines the why, explain what you found and why it matters before asking the user to reconsider.

**Decision records are settled context.** Treat relevant DRs from step 2 the same way as brainstorm decisions — if a DR already covers a decision you'd otherwise ask about, don't re-ask. Mention that you're following it so the user has visibility. Only revisit if your code investigation contradicts the reasoning captured in the DR.

**Superseding a DR is a mandatory conversation.** If a decision being made contradicts an existing DR, stop and surface the conflict explicitly: which DR, what it says, and what contradicts it. Let the user decide whether to supersede. Never silently override a DR. If the user agrees to supersede, capture it in the plan's `### DR Supersessions` section under Architecture (see artifact format).

Not every category below requires a decision every time. If the codebase already has well-established patterns for the type of work being done, align to them — don't ask the user to choose what's already settled. Only surface decisions where there's a genuine choice to make.

Typical decisions include:

- **Module impact** — which existing modules are affected and how their responsibilities shift
- **New modules** — whether new modules are needed, what they own, where they live
- **Interfaces** — key contracts between modules, data shapes, API boundaries
- **Patterns** — architectural patterns, state management, data flow
- **Technology choices** — introducing new dependencies or replacing existing ones

For **technology choices**, always present **2–3 genuinely different options** with trade-offs. These are high-stakes decisions — the user picks, not the agent.

For other decisions, lead with your recommendation based on what you found in the code, but stay open to the user's input.

**Capture the reasoning.** When the user makes a decision — about technology, interfaces, module boundaries, or anything else — make sure the *why* is captured, not just the *what*. If the reasoning isn't obvious and the user doesn't explain it, ask.

### 4. Capture the Outcome

Write the architectural section of `docs/plans/<topic>.md`. Follow the artifact format below. Commit with message: `architect: <topic>`

## Artifact Format

```markdown
# Plan: [Topic]

## Context

[What we're building and why. 2-3 sentences. Link to brainstorm if one exists.]

## Architecture

### Impacted Modules

[For each affected module: what changes and why. Reference the codemap module names.]

### New Modules

[If any. Purpose, responsibilities, where they live. If none, omit this section.]

### Interfaces

[Interfaces affected by the changes. Data shapes, API boundaries, communication patterns. Enough to understand how the pieces connect — not full API specs.]

### Technology Choices

[Any new tech being introduced or existing tech being replaced. What was chosen and why, what alternatives were considered.]

### DR Supersessions

- **DR-NNN** (<title>) — superseded because [reason]. New decision: [summary of what replaces it].
```

### Format Rules

- **Context** — brief. The brainstorm already covers the exploration; don't repeat it. Link to `docs/brainstorms/<topic>.md` if one exists.
- **Impacted Modules** — use the codemap's module names. Focus on what changes about each module's responsibilities and dependencies, not file-level details.
- **New Modules** — same level of detail as a codemap module entry: purpose, responsibilities, dependencies, approximate location. Not exact files.
- **Interfaces** — only interfaces affected by the changes. Enough for someone to understand the boundaries and data flow. Pseudocode or type signatures are fine if they clarify; don't force them if prose is clearer.
- **Technology Choices** — only present when new tech is introduced or existing tech is replaced. Include what was considered and why the choice was made. Omit this section if no technology decisions were needed.
- **DR Supersessions** — only present when the architecture supersedes one or more existing decision records. List each superseded DR with its number, title, reason for supersession, and a summary of the replacement decision. Cleanup uses this section to delete old DRs and write replacements with provenance.
- **Omit empty sections.** If there are no new modules, no technology choices, or no DR supersessions, leave those sections out entirely.

## Key Principles

- **Grounded in code** — every decision should be informed by what's actually in the codebase, not assumptions about it
- **One decision at a time** — conversational, not a monologue. Check in with the user on each decision.
- **Options for tech choices** — always 2-3 genuine alternatives with trade-offs for technology decisions. The user picks.
- **Shape, not sequence** — decide what the architecture looks like, not the order to build it
- **The codemap is the map** — use its module names, respect its boundaries, note when boundaries need to shift
- **YAGNI** — don't architect what isn't needed. If a simple approach works, take it.
- **Decision records are settled context** — check `docs/decisions/` before making decisions. Follow existing DRs; superseding one is always a conversation with the user.
- **Code snippets for shape, not implementation** — use code in the plan when it communicates shape more clearly than prose: interfaces, type signatures, data structures, module boundaries. Avoid implementation snippets (function bodies, algorithms, logic) — those pre-empt TDD and constrain the implementer unnecessarily. When prose is equally clear, prefer prose.
