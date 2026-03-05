---
name: brainstorming
description: "Collaborative brainstorming for exploring ideas before building. Use before any creative or design work — features, components, projects, or changes. Turns rough ideas into well-explored directions through dialogue."
---

# Brainstorming

## Overview

Help the user explore an idea through natural, collaborative dialogue. The goal is to understand what they're really after, surface things they haven't considered, open up the solution space, then converge on a direction worth pursuing. Leave behind an artifact that captures the outcome.

A good brainstorm doesn't just organize what the user already knows — it helps them discover what they didn't know they didn't know.

Do NOT jump to implementation. No code, no scaffolding, no "let me set that up for you." The output of brainstorming is clarity, not code.

## Anti-Pattern: Skipping Ahead

It's tempting to skip brainstorming when something feels obvious. Resist this. "Simple" ideas are where unexamined assumptions waste the most effort. The brainstorm can be short — a few exchanges and a brief summary — but it should still happen.

## Process

### 1. Understand the Idea

Ask clarifying questions **one at a time**. Don't overwhelm with a list of five questions — have a conversation.

Prefer multiple choice when it helps, but open-ended is fine too. The goal is to understand purpose, constraints, and what success looks like.

Use creative questioning techniques to push beyond surface-level answers:

- **Substitute** — "What if we swapped X for Y?"
- **Combine** — "Could this merge with something that already exists?"
- **Adapt** — "Is there something elsewhere that already solves a version of this?"
- **Eliminate** — "What if we dropped the part everyone assumes is necessary?"
- **Reverse** — "What if we flipped the flow entirely?"
- **Constraint removal** — "If there were zero limitations, what would this look like?"
- **Reverse brainstorming** — "What would make this actively worse?" (to surface hidden priorities)

You don't need to use all of these. Pick the ones that fit the moment. The point is to surface blind spots and help the user think beyond their first instinct. Ask about edges they haven't mentioned — failure modes, second-order effects, who else is affected, what happens at scale, what happens on day two. The most valuable question is often the one the user wouldn't have thought to ask themselves.

### 2. Explore Approaches

Once you understand the idea, propose **2–3 different approaches** with trade-offs. Lead with your recommendation and explain why. Keep it conversational — this isn't a formal presentation.

The approaches should feel genuinely different, not minor variations of the same thing.

### 3. Converge

Check in with the user as the direction takes shape. Validate incrementally — don't disappear for ten paragraphs and then reveal a grand plan. Short exchanges, building toward agreement.

Apply YAGNI ruthlessly. If something isn't clearly needed, cut it.

### 4. Capture the Outcome

Write a brainstorming artifact that captures:

- **The idea** — what we set out to explore
- **Key decisions** — what was considered and what was chosen, with reasoning
- **Direction** — the agreed-upon approach
- **Open questions** — anything unresolved that needs future attention

Save to `docs/brainstorms/<topic>.md` and commit. Keep it concise — this is a reference, not a novel.

## Key Principles

- **One question at a time** — have a conversation, don't interrogate
- **Surface the unknown unknowns** — ask about angles the user hasn't considered
- **Genuinely different options** — not three flavors of the same idea
- **Incremental validation** — check in often, don't monologue
- **YAGNI** — cut what isn't clearly needed
- **No implementation** — the output is a direction, not code
