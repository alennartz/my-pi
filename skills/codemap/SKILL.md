---
name: codemap
description: "Generate or update a codemap — a living map of a codebase's modules, responsibilities, dependencies, and file ownership. Use when starting work on an unfamiliar codebase, after significant structural changes, or when asked to create/refresh a codemap."
---

# Codemap

## Overview

Analyze a codebase and produce `codemap.md` at the repo root — a compact, information-dense guide that maps the system's logical modules to their files. The codemap is the primary artifact other skills and agents use to understand a codebase without reading every file.

The codemap optimizes for **agent consumption**: it should be compact enough to load whole and detailed enough that the agent can triage which modules to explore for any given task without opening files.

## Operations

### Generate

Produce a codemap from scratch. Use for initial setup or full refresh.

1. **Survey the codebase.** Read the project's entry points, directory structure, config files, and key source files. Use `find`, `ls`, and selective `read` to build understanding — don't try to read every file, focus on structure and boundaries.

2. **Identify modules.** A module is a logical unit of responsibility — tightly coupled inside, loosely coupled to other modules. Look for:
   - Directory boundaries that align with a single responsibility
   - Groups of files that work together on one concern
   - Clear API surfaces or interfaces between parts of the system
   - A module may be a single file, a directory, or span multiple directories — follow the logic, not the filesystem

3. **Write `codemap.md`.** Follow the artifact format below exactly. Place it at the repo root.

4. **Commit.** Commit the codemap with message: `codemap: generate`

### Update

Refresh an existing codemap after changes. Use when files have been added, removed, moved, or when module boundaries have shifted.

1. **Read the current `codemap.md`** — it may contain human edits that should be preserved where still accurate.

2. **Survey what changed.** Check the current codebase structure against what the codemap describes. Look for:
   - New files not covered by any module's globs
   - Deleted files still referenced
   - Modules whose responsibilities have shifted
   - New modules that have emerged
   - Modules that should be merged or split

3. **Rewrite the affected sections.** Preserve accurate content (including human edits). Update what's stale. Add what's missing. Remove what's gone.

4. **Commit.** Commit with message: `codemap: update`

## Artifact Format

The codemap is markdown with embedded mermaid diagrams. It follows this exact structure:

```markdown
# Codemap

## Overview

[1-3 sentences: what the system is, what it does, what it's built with.]

​```mermaid
graph LR
  ModuleA --> ModuleB
  ModuleA --> ModuleC
  ModuleC --> ModuleD
​```

## Modules

### [Module Name]

[One-line purpose.]

**Responsibilities:** [comma-separated list of key concepts this module owns]

**Dependencies:** [module names with brief reason, or "none"]

**Files:**
- `src/module-name/**`
- `src/shared/relevant-file.ts`
```

### Format Rules

- **Overview** — system summary + mermaid dependency graph showing how modules relate. Keep the mermaid graph high-level: modules as nodes, arrows for dependencies.
- **Module sections** — one `###` heading per module under `## Modules`. Each contains:
  - A one-line purpose statement (no bold label, just the sentence)
  - **Responsibilities** — what it owns, comma-separated. Dense enough for triage: "can I skip this module for my current task?"
  - **Dependencies** — which other modules it depends on and why. Include reverse dependencies if non-obvious. Use "none" if standalone.
  - **Files** — glob patterns. Use `dir/**` when an entire directory belongs to the module. List individual files when ownership is scattered.
- **Every file in the codebase should be covered by exactly one module's globs.** If a file doesn't fit anywhere, that's a signal you're missing a module or a module's scope is too narrow.
- **Module count should be small.** Aim for the fewest modules that accurately capture the system's logical structure. 3-8 modules is typical; more than 12 is a red flag that modules are too granular.
- **Mermaid and module names must match exactly** — same names in the graph and the headings.

## Judgment Calls

The hard part of codemap generation is deciding module boundaries. Some guidelines:

- **Prefer fewer, broader modules** over many narrow ones. The codemap is for orientation, not documentation of every internal boundary.
- **Name modules by what they do**, not by directory name (though they'll often coincide).
- **Config, scripts, and infra files** still need a home. Group them into a module (e.g., "Build & Config") rather than leaving them unmapped.
- **Test files** belong to the module they test — include them in that module's globs.
- **When in doubt, merge.** Two things that feel like they might be separate modules but have heavy cross-dependencies are probably one module.

## Key Principles

- **Compact over comprehensive** — the codemap is a guide, not documentation. One line per module is better than a paragraph.
- **Every file mapped** — no orphans. If it's in the repo, it belongs to a module.
- **Agent-first** — optimize for an agent loading this whole and making fast decisions about what to read next.
- **Honest about uncertainty** — if a module boundary is unclear, say so rather than pretending it's clean.
