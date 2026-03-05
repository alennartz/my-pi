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
   - Rarely, a single file may contain code serving multiple modules. Flag these in both modules' file lists rather than forcing a false assignment

3. **Write `codemap.md`.** Follow the artifact format below exactly. Place it at the repo root.

4. **Commit.** Commit the codemap with message: `codemap: generate`

### Update

Refresh an existing codemap after changes. Updates come in two flavors:

**Scoped update** — the caller specifies what changed (e.g., "added a new auth module", "moved files from X to Y"). This is the common case. Don't re-survey the whole codebase — focus on the stated changes:

1. **Read the current `codemap.md`.**
2. **Examine the specific changes** described by the caller.
3. **Update the affected sections.** Preserve everything else as-is.
4. **Commit.** Commit with message: `codemap: update`

**Full update** — no specific scope given, just "update the codemap." Do a full analysis:

1. **Read the current `codemap.md`** — it may contain human edits that should be preserved where still accurate.
2. **Survey the codebase.** Check the current structure against what the codemap describes. Look for:
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

### Key Flows

[1-2 primary data or control flows through the system. Pick the flows that best illustrate how the modules interact at runtime.]

​```mermaid
sequenceDiagram
  participant A as ModuleA
  participant B as ModuleB
  participant C as ModuleC
  A->>B: request
  B->>C: process
  C-->>B: result
  B-->>A: response
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

- **Overview** — system summary + mermaid dependency graph showing how modules relate. Keep the mermaid graph high-level: modules as nodes, arrows for dependencies. Follow with a "Key Flows" subsection: 1-2 sequence diagrams showing the primary data or control flows at runtime. Pick the flows that best reveal how modules interact — skip this if the system is too simple to benefit.
- **Module sections** — one `###` heading per module under `## Modules`. Each contains:
  - A one-line purpose statement (no bold label, just the sentence)
  - **Responsibilities** — what it owns, comma-separated. Dense enough for triage: "can I skip this module for my current task?"
  - **Dependencies** — which other modules it depends on and why. Include reverse dependencies if non-obvious. Use "none" if standalone.
  - **Files** — glob patterns. Use `dir/**` when an entire directory belongs to the module. List individual files when ownership is scattered.
- **Every code file should be covered by at least one module's globs.** If a source file doesn't fit anywhere, that's a signal you're missing a module or a module's scope is too narrow. Non-code files (docs, config, CI, etc.) can be included where natural but don't need to be forced into a module. Rarely, a file may legitimately belong to multiple modules — this is fine to represent, but if it happens often it's a sign of tangled responsibilities.
- **Module count should be small.** Aim for the fewest modules that accurately capture the system's logical structure. 3-8 modules is typical; more than 12 is a red flag that modules are too granular.
- **Mermaid and module names must match exactly** — same names in the graph and the headings.

## Judgment Calls

The hard part of codemap generation is deciding module boundaries. Some guidelines:

- **Prefer fewer, broader modules** over many narrow ones. The codemap is for orientation, not documentation of every internal boundary.
- **Name modules by what they do**, not by directory name (though they'll often coincide).
- **Config, scripts, and infra files** — include them in a module if there's a natural fit, but don't force them. A top-level `tsconfig.json` doesn't need a module.
- **Test files** belong to the module they test — include them in that module's globs.
- **When in doubt, merge.** Two things that feel like they might be separate modules but have heavy cross-dependencies are probably one module.
- **Ask when genuinely uncertain.** If a boundary call isn't clear from the code, ask the user — they know the intent. A quick question is cheaper than a wrong module boundary.

## Key Principles

- **Compact over comprehensive** — the codemap is a guide, not documentation. One line per module is better than a paragraph.
- **Every code file mapped** — no orphan source files. Non-code files (docs, config, CI, etc.) can be mapped to a module if it makes sense, but don't force it.
- **Agent-first** — optimize for an agent loading this whole and making fast decisions about what to read next.
- **Honest about uncertainty** — if a module boundary is unclear, say so rather than pretending it's clean.
