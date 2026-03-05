# Brainstorm: Architecting Skill

## The Idea

A skill that makes concrete architectural decisions for a feature or change, grounded in the actual codebase. Sits between brainstorming (non-technical exploration) and implementation planning (concrete steps). Reads the codemap and dives into relevant code to turn a direction into a technical shape.

## Key Decisions

### Position in the pipeline: brainstorm → architect → implementation plan
- Brainstorm explores the idea non-technically — what, why, trade-offs at a conceptual level
- Architect refines through a technical lens — which modules, patterns, interfaces, tech choices
- Implementation plan takes the architecture and produces an ordered sequence of concrete steps
- Architect decides the shape, implementation plan decides the sequence

### Grounded in the codemap and real code
- Reads `codemap.md` before anything else to understand the codebase structure
- Dives into code files of impacted modules during the conversation — decisions are informed by what's actually there, not assumptions
- Notes codemap implications (new modules, shifted responsibilities) but does not update the codemap itself — the codemap reflects reality, not plans

### Conversational flow, one decision at a time
- Similar to brainstorming: present decisions incrementally, get user input on each
- Unlike brainstorming: the conversation is grounded in code, not just ideas
- For technology choices (introducing or replacing tech), presents 2-3 genuinely different options with trade-offs and lets the user pick

### Brainstorm input is optional
- If the user links a brainstorm, reads `docs/brainstorms/<topic>.md` as input
- If no brainstorm is linked and the scope feels too vague or large, suggests the user brainstorm first
- Can also work directly from a user description — the brainstorm artifact is not required

### Artifact is the first half of the implementation plan doc
- Writes to `docs/plans/<topic>.md`
- The implementation plan skill later picks up and adds concrete steps below
- Single artifact, not scattered across files

### Scope: the technical what and the structural how
- Refines the brainstorm's non-technical direction under a technical lens
- Gets into the how at an architectural level — patterns, module structure, interfaces, tech choices
- Stops short of concrete steps, specific files, or ordered sequences — that's the implementation plan's job

## Artifact Contents

- **Context** — what we're building and why (brief, links to brainstorm if one exists)
- **Impacted modules** — what existing modules are affected and how
- **New modules** — if any, their purpose, responsibilities, and where they live
- **Interfaces** — key contracts between modules
- **Technology choices** — what's being introduced or replaced, with reasoning
- **Codemap implications** — what will need to change in the codemap after implementation

## Direction

Build an architecting skill that reads the codemap, investigates relevant code, and makes architectural decisions through conversation with the user. It produces the first half of `docs/plans/<topic>.md`, which the implementation plan skill later completes. The flow is conversational and grounded in real code — one decision at a time, with 2-3 options for technology choices. Brainstorm artifacts are used when available but not required.

## Open Questions

None — ready to build.
