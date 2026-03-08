# Brainstorm: Debugging Skill

## The Idea

A systematic debugging skill that enforces a "no fixes without root cause investigation" philosophy. Inspired by [obra/superpowers systematic-debugging](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) but leaner, prose-only, and aligned with our existing skill style.

## Key Decisions

### Skill, not prompt template
We explored making this a prompt template (`/debug`) but came back to a skill. Skills are auto-discoverable — the agent reaches for the debugging methodology whenever it encounters bugs or failures without the user needing to explicitly invoke it. Skills can still be invoked manually when needed.

### Three phases, not four
The source material uses four phases (Root Cause Investigation, Pattern Analysis, Hypothesis & Testing, Implementation). We collapsed Pattern Analysis into the investigation phase — comparing working vs. broken code is just part of investigating. Implementation was trimmed to avoid overlap with the existing implementing skill. The result is three phases: **Investigate → Hypothesize & Test → Fix**.

### Root-cause tracing folded in
Rather than a separate supporting file, the backward-tracing technique (trace up the call chain to find where bad data originates, fix at the source not the symptom) is part of the investigation phase directly.

### Escalation over rigidity
The source material has a rigid "3 failed fixes → stop" rule. We replaced this with a judgment-based escape hatch: if the investigation reveals the problem is architectural, or the fix would require large-scale refactoring, stop and bring the human in for discussion. The agent should recognize when autonomous action isn't appropriate — not count attempts.

### Prose only, no code examples
Matches the style of our existing skills. No code blocks, no bash snippets, no instrumentation examples. Trust the agent to apply the methodology contextually.

### Cut the bulk
Dropped the rationalizations table, red flags checklist, and "human partner signals" section from the source material. The philosophy is conveyed through the process itself, not through lists of anti-patterns.

## Direction

A single-file skill with frontmatter, overview, three-phase process, and key principles. Triggers on bugs, test failures, and unexpected behavior. Core message: always investigate before fixing, trace to root cause, one hypothesis at a time, escalate to the human when the problem is bigger than a bug.

## Open Questions

- Exact trigger wording for the frontmatter description — broad enough to auto-trigger on failures, specific enough not to fire on trivial issues like typos.
