# Review: Scout Agent

**Plan:** `docs/plans/scout-agent.md`
**Diff range:** `08353326..0602d52`
**Date:** 2026-03-21

## Summary

Both plan steps were implemented faithfully — the agent definition and package manifest registration are correct and complete. The prompt covers all required topics but has two gaps relative to the brainstorm's goals: scout doesn't understand its core purpose (token savings), and the exploration guidance is tool-mechanical without strategy for the analytical/relationship tasks the brainstorm wants it to handle.

## Findings

### 1. Scout's self-understanding doesn't include its core purpose

- **Category:** code correctness
- **Severity:** warning
- **Location:** `agents/scout.md:8-9`
- **Status:** dismissed

The brainstorm's central thesis is token savings — scout exists to run cheaply so the parent doesn't burn expensive tokens on exploration. The prompt tells scout *what* to do ("explore the codebase... return what you find so the parent can read only what matters") but not *why* it matters (it's the budget-conscious agent on a cheap model). For cheaper models especially, understanding the purpose shapes behavior: it encourages efficient exploration (don't read everything when a targeted search suffices), concise-but-complete output (don't pad with unnecessary prose), and smart prioritization (focus on what the parent actually needs). Without this framing, scout may over-explore or produce unnecessarily verbose responses, partially defeating the value proposition.

### 2. Exploration section lacks strategy for analytical and relationship tasks

- **Category:** code correctness
- **Severity:** warning
- **Location:** `agents/scout.md:15-17`
- **Status:** resolved

The brainstorm says scout should handle analytical questions like "what would I need to touch to add Y?" and "explores and reasons about relationships, not just locates files." The Output section describes the analytical task type, but the Exploration section — where the model gets its approach instructions — is purely about tool mechanics (bash for grep/find/ls, read for targeted sections) with one line about following references and imports. There's no guidance on tracing dependency chains across modules, reading type signatures to understand interfaces, checking how callers use a function, or building a structural understanding of how parts connect before answering. A cheaper model given only mechanical tool instructions will tend to do mechanical exploration — sufficient for focused lookups but likely to fall short on the analytical tasks the brainstorm explicitly wants scout to handle.

## No Issues

Plan adherence: no significant deviations found. Both steps were implemented as specified — frontmatter has all required fields, system prompt covers all five planned topics, and `package.json` correctly registers the agents directory.
