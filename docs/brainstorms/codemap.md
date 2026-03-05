# Brainstorm: Codemap Skill

## The Idea

A skill that auto-generates and maintains a living map of a codebase — giving the agent a context-efficient backbone for understanding and navigating code. Solves the root problem that agents lack codebase context when planning and implementing, leading to hallucinated structures and missed constraints.

## Key Decisions

### Codemap is the next skill after brainstorming
- It's foundational — other skills (like technical planning/architecture) depend on the codemap artifact
- Skills are independent of each other; artifacts are the shared language between them
- It solves the #1 failure mode identified: agent not having proper context loaded about the codebase
- Self-contained, no dependencies on other skills

### Fully auto-generated, human-editable
- Agent analyzes the codebase and makes judgment calls on module boundaries
- All decisions are explicitly documented in the artifact
- User can review and alter the artifact at any time — it's the source of truth regardless of who wrote which parts

### What a module is
- A logical unit of responsibility in the codebase — tightly coupled inside, loosely coupled to other modules
- May or may not align with directory structure in existing codebases
- The codemap describes modules well enough that the agent can triage which modules to explore for a given task without opening any files

### Per-module content
- **Purpose** — one-line description of what it does
- **Responsibilities** — key concepts and things it owns (so the agent can triage: "auth owns sessions, tokens, permissions")
- **Dependencies** — what it depends on and what depends on it (so the agent knows the blast radius)
- **Files** — glob patterns mapping files to the module. Shorthand: a whole-directory glob like `src/auth/**` when a folder is entirely owned by one module

### Artifact format: markdown with mermaid
- Markdown — readable by humans, parseable by agents, editable without tooling
- Mermaid diagrams inline with text for expressing relationships — extremely information-dense, already markdown-native (fenced code blocks)
- Structured by consistent conventions (headings, bullet patterns) so the agent can parse reliably

### Artifact structure
1. **System overview** — high-level summary of the codebase + mermaid diagram showing module relationships
2. **Modules** — each module gets its own section with purpose, responsibilities, dependencies, and file globs (all inline, self-contained per module)

### Two operations: generate and update
- **Generate** — analyze a codebase and produce the map from scratch. Used for initial setup or full refresh
- **Update** — refresh the map after changes (new/removed/moved files, adjusted module boundaries)
- The codemap skill handles both operations, but other skills are responsible for triggering updates as part of their workflows

### Single-pass analysis (for now)
- Assumes the codebase is small enough for the agent to analyze in one pass
- Scaling to larger codebases is a future concern

### Primary consumer is the agent
- The artifact is loaded whole — it's the guide for the codebase
- Optimized for compact, information-dense context
- Human readability is secondary but not sacrificed — markdown + mermaid is natural for both

## Artifact Example

```markdown
# Codemap

## Overview

Pi is a coding agent harness — a TUI that connects to LLM providers, manages
conversations, and lets users extend behavior through skills, themes, and
extensions. Built in TypeScript, runs on Node.

​```mermaid
graph LR
  TUI --> Agent
  Agent --> Providers
  Agent --> Skills
  TUI --> Themes
  Extensions --> TUI
  Extensions --> Agent
​```

## Modules

### Agent

The core conversation and tool-execution loop.

**Responsibilities:** message handling, tool dispatch, context management, streaming responses

**Dependencies:** Providers (for LLM calls), Skills (for skill-specific tool definitions)

**Files:**
- `src/agent/**`

### Providers

LLM provider integrations — translating between the agent's internal format and provider-specific APIs.

**Responsibilities:** API communication, model listing, auth, response streaming, format translation

**Dependencies:** none

**Files:**
- `src/providers/**`

### TUI

Terminal UI layer — rendering, input handling, layout.

**Responsibilities:** conversation display, input capture, status indicators, scrolling, viewport management

**Dependencies:** Agent (subscribes to conversation state), Themes (for styling)

**Files:**
- `src/tui/**`
- `src/index.ts`

### Skills

Skill loading and registration system.

**Responsibilities:** skill discovery, SKILL.md parsing, skill invocation protocol

**Dependencies:** Agent (skills are invoked through the agent loop)

**Files:**
- `src/skills/**`

### Themes

Visual theming system for the TUI.

**Responsibilities:** color schemes, style tokens, theme loading

**Dependencies:** none

**Files:**
- `src/themes/**`
- `themes/*.json`

### Extensions

User-installable extensions that hook into agent and TUI behavior.

**Responsibilities:** extension loading, lifecycle hooks, API surface for extensions

**Dependencies:** Agent, TUI (extensions modify both)

**Files:**
- `src/extensions/**`
```

## Direction

Build a codemap skill with generate and update operations. The artifact is markdown with embedded mermaid diagrams, structured by consistent conventions. Each module section is self-contained with purpose, responsibilities, dependencies, and file globs. The artifact is loaded whole by the agent as a codebase guide, enabling it to triage which modules to explore for any given task.

### Artifact location: repo root
- `codemap.md` at the root of the repository — simple, visible, conventional
- Referenced from `agents.md` — the codemap is exactly the kind of artifact that `agents.md` should link to as an entry point for codebase context

### Cross-skill referencing: known path convention
- Skills that need the codemap just read `./codemap.md` — no invocation protocol needed

### Updates are simple
- The agent rereads the current codemap before updating, so it sees everything including human edits
- No change detection machinery — agent reads the codemap, looks at the codebase, rewrites what needs rewriting

## Open Questions

None — ready to build.
