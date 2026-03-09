# Agents

## Codebase Overview

See [codemap.md](./codemap.md) for a full map of modules, responsibilities, dependencies, and file ownership.

## Project Structure

This is a [pi coding agent](https://github.com/badlogic/pi-mono) package. It contains:

- **`skills/`** — Custom workflow skills loaded by the pi agent harness. Each skill is a `SKILL.md` file with structured instructions.
- **`extensions/`** — TypeScript extensions loaded by pi at runtime. Currently: Azure AI Foundry provider, workflow pipeline orchestration.
- **`lib/components/`** — Reusable TUI components shared across extensions (TypeScript).
- **`docs/brainstorms/`** — Ephemeral brainstorm artifacts for in-progress workflows.
- **`docs/plans/`** — Ephemeral plan artifacts for in-progress workflows (architecture + implementation steps).
- **`docs/reviews/`** — Ephemeral review artifacts for in-progress workflows.
- **`docs/decisions/`** — Permanent decision records extracted during cleanup (DR-NNN format).
- **`prompts/`** — Custom prompt templates (currently empty).
- **`themes/`** — Custom themes (currently empty).

## Conventions

- Skills are Markdown files following the pi skill format (YAML frontmatter + structured sections).
- The extension uses TypeScript and imports from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`.
- Design decisions for new skills should be documented in `docs/brainstorms/` before implementation.
- **Never try to build, compile, or type-check this project.** Extensions are raw TypeScript loaded by pi at runtime — there is no build step, no `tsc`, no bundler. Editing the `.ts` files is the final step.
