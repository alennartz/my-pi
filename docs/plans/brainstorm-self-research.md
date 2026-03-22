# Plan: Brainstorm Self-Research

## Context

The brainstorming skill sometimes asks the user factual/context questions it could answer on its own using available tools. We're adding guidance to close this gap. See [brainstorm](../brainstorms/brainstorm-self-research.md).

## Architecture

### Impacted Modules

- **Skills** (`skills/brainstorming/SKILL.md`) — Adding a new anti-pattern to the existing Anti-Patterns section. Placed after "Question Dumping" as a sibling concept (same family of questioning mistakes). The anti-pattern should:
  - Name the failure mode: asking the user questions the agent could answer with its tools
  - Give the fact-vs-intent heuristic: research facts and context yourself, ask the user about intent, priorities, and preferences
  - Encourage using available tools generically (reading files, running commands, searching online) without naming specific skills
  - Keep it concise — comparable in length to the existing anti-patterns

## Steps

**Pre-implementation commit:** `e470b2bf6f0bd2d0b77c03dfb90330895e4b1967`

### Step 1: Add "Asking Answerable Questions" anti-pattern

In `skills/brainstorming/SKILL.md`, add a new `### Asking Answerable Questions` subsection in the Anti-Patterns section, after "Question Dumping" and before "Monologuing". Match the concise style of the existing anti-patterns. The content should:

- Name the failure: asking the user something you could look up with your tools
- Give the heuristic: facts and context → research it yourself; intent, priorities, preferences → ask the user
- Mention tools generically (read files, run commands, search online) without naming specific skills

**Verify:** Read the skill file, confirm the new anti-pattern is present between Question Dumping and Monologuing, reads naturally alongside its siblings, and doesn't reference any specific skill names.
**Status:** done
