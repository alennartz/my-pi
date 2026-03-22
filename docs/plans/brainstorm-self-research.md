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
