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
