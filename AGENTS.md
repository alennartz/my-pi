# Agents

## Codebase Overview

See [codemap.md](./codemap.md) for a full map of modules, responsibilities, dependencies, and file ownership.

## Project Structure

This is a [pi coding agent](https://github.com/badlogic/pi-mono) package. It contains:

- **`skills/`** — Custom workflow skills loaded by the pi agent harness. Each skill is a `SKILL.md` file with structured instructions.
- **`extensions/`** — Provider extensions (TypeScript). Currently: Azure AI Foundry provider.
- **`docs/brainstorms/`** — Design rationale documents behind each skill.
- **`prompts/`** — Custom prompt templates (currently empty).
- **`themes/`** — Custom themes (currently empty).

## Conventions

- Skills are Markdown files following the pi skill format (YAML frontmatter + structured sections).
- The extension uses TypeScript and imports from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`.
- Design decisions for new skills should be documented in `docs/brainstorms/` before implementation.
