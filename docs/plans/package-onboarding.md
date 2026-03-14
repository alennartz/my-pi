# Plan: Package Onboarding

## Context

This package needs a personal behavioral convention file (`SYSTEM.md`) and an onboarding prompt template (`/onboard`) that documents the package's features and walks users through setup. See [brainstorm](../brainstorms/package-onboarding.md).

## Architecture

### Impacted Modules

**Docs** — gains `SYSTEM.md` at the package root (a static behavioral convention file, outside the `docs/` tree) and `prompts/onboard.md` (a prompt template discovered via the existing `pi.prompts` manifest entry). No changes to existing files or responsibilities.

### Interfaces

**`SYSTEM.md`** — a plain Markdown file at the package root containing behavioral conventions for the agent. One convention for now (pause at explore→act boundaries with ~200-300 word chunks). Flat list format — no categories until there are enough conventions to warrant them. Users copy this content into their own `AGENTS.md` (project-level or global).

**`prompts/onboard.md`** — a pi prompt template invoked as `/onboard`. No arguments. Covers:
- What the package provides (workflow pipeline, Azure Foundry provider, standalone skills, TUI components)
- The `SYSTEM.md` convention and what it does
- Actively offers to install the `SYSTEM.md` content into the user's `AGENTS.md` — shows the content, then asks whether to add it to the project's `AGENTS.md` or the global `~/.pi/agent/AGENTS.md`

## Steps

**Pre-implementation commit:** `538e0389c8c572afacdcc54c4256cc0f89f9ed97`

### Step 1: Create `SYSTEM.md` at the package root

Create `SYSTEM.md` containing one behavioral convention: pause at the explore→act boundary. Tone should be direct and imperative — this is system prompt content. Flat list format (one rule under a heading, more can be added later). The convention must cover:

- **The trigger:** transitioning from an exploratory/discussion phase (brainstorming, investigating, diagnosing, planning) to an action phase (writing files, running commands, editing code)
- **The behavior:** pause and present what you're about to do in digestible chunks before proceeding
- **Chunk sizing:** ~200-300 words max per chunk
- **The gate:** wait for user feedback before moving to the next chunk
- **Scope:** applies across all contexts — workflow skill transitions, debugging fix proposals, mid-task course changes. The boundary between "building understanding" and "doing things" always deserves a pause.

**Verify:** `SYSTEM.md` exists at the repo root. Content covers the trigger, behavior, chunk sizing, feedback gate, and cross-context scope.
**Status:** done

### Step 2: Create `prompts/onboard.md`

Create the `/onboard` prompt template at `prompts/onboard.md` with a `description` in YAML frontmatter. No arguments. The template body should:

1. Briefly introduce the package (what it is, what it provides)
2. List the key features: workflow pipeline (brainstorm → architect → plan → implement → review → cleanup), Azure Foundry provider, standalone skills (codemap, debugging), TUI components (numbered-select)
3. Explain `SYSTEM.md` — what it contains, why it exists, and that it needs to be installed into the user's `AGENTS.md`
4. Show the `SYSTEM.md` content inline
5. Offer to install it — ask the user whether to append it to the project's `AGENTS.md` or the global `~/.pi/agent/AGENTS.md`

**Verify:** `prompts/onboard.md` exists, has YAML frontmatter with `description`, and covers all five content areas above.
**Status:** done

### Step 3: Remove `prompts/.gitkeep`

Delete `prompts/.gitkeep` — the directory now has a real file.

**Verify:** `.gitkeep` is gone; `prompts/` contains only `onboard.md`.
**Status:** not started
