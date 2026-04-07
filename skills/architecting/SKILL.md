---
name: architecting
description: "Make architectural decisions for a feature or change, grounded in the actual codebase. Use when the user needs to evaluate approaches, choose between designs, or define the technical shape of upcoming work — whether following a brainstorm or starting from a clear direction. Produces docs/plans/<topic>.md with the architecture section."
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

Identify which modules from the codemap are likely impacted. Scout those modules — locate their entry points, public interfaces, and key files.

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

**Watch for summarization drift.** When any decision involved extended back-and-forth — especially where you initially leaned one direction and the user corrected you, or where you worked through confusion together — re-read the conversation to find the specific exchange where agreement was reached. Capture *that*, not your general impression of the discussion. The longer and more contested a decision was, the more likely your summary will regress toward your earlier (wrong) position, because that's where your completions were already leaning. If you argued for X, the user corrected you toward Y, and you agreed Y was right — the plan must say Y, with Y's reasoning. Not a softened version of X.

Write the architectural section of `docs/plans/<topic>.md`. Follow the artifact format below.

### 5. Check for Blind Spots

If `docs/brainstorms/<topic>.md` exists, spawn a default subagent with the brainstorm and plan file paths. Its task: read both files and identify brainstorm intent that the architecture doesn't cover. Each gap should name the missing intent and explain why the architectural decisions don't address it.

Wait for `<agent_idle>`. If the subagent fails, inform the user and proceed to commit. Otherwise, review the output — filter noise (intent already covered, or out of scope) and surface substantive findings to the user. The user decides per finding: revisit the architecture to cover it, or dismiss. Update the plan file if the architecture was extended.

If no brainstorm exists, skip the check.

Commit with message: `architect: <topic>`

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

[Component boundary contracts for interfaces affected by the changes. For each boundary: what data flows across it (shapes, structures), what operations each component exposes, and what contracts callers and callees must satisfy. These must be specific enough that a test writer can materialize them as code — types, function signatures, expected behaviors — without making design decisions. Pseudocode and type signatures encouraged. Not full API specs, but thorough enough to code against.]

### Technology Choices

[Any new tech being introduced or existing tech being replaced. What was chosen and why, what alternatives were considered.]

### DR Supersessions

- **DR-NNN** (<title>) — superseded because [reason]. New decision: [summary of what replaces it].
```

### Format Rules

- **Context** — brief. The brainstorm already covers the exploration; don't repeat it. Link to `docs/brainstorms/<topic>.md` if one exists.
- **Impacted Modules** — use the codemap's module names. Focus on what changes about each module's responsibilities and dependencies, not file-level details.
- **New Modules** — same level of detail as a codemap module entry: purpose, responsibilities, dependencies, approximate location. Not exact files.
- **Interfaces** — component boundary contracts for interfaces affected by the changes. Describe what data flows across each boundary, what operations each side exposes, and what shapes are expected. Be specific enough that a test writer can materialize these as real code (types, function signatures, behavioral expectations) without making design decisions. Pseudocode and type signatures encouraged when they add precision; prose alone is fine when the contract is simple.
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
- **Code snippets for shape, not implementation** — use code in the plan when it communicates shape more clearly than prose: interfaces, type signatures, data structures, module boundaries. Avoid implementation snippets (function bodies, algorithms, logic) — those pre-empt TDD and constrain the implementer unnecessarily. When prose is equally clear, prefer prose. Interface descriptions are the primary input for the test-writing phase — the test writer materializes them as real code and writes behavioral tests against them, potentially in a clean context with no access to the architectural conversation. What you write in the Interfaces section is what they have to work with.
