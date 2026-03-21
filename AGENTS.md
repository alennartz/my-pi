# Agents

## Codebase Overview

See [codemap.md](./codemap.md) for a full map of modules, responsibilities, dependencies, and file ownership.

## Conventions

- Skills are Markdown files following the pi skill format (YAML frontmatter + structured sections).
- The extension uses TypeScript and imports from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`.
- Design decisions for new skills should be documented in `docs/brainstorms/` before implementation.
- **Never try to build, compile, or type-check this project.** Extensions are raw TypeScript loaded by pi at runtime — there is no build step, no `tsc`, no bundler. Editing the `.ts` files is the final step.
- **Subagents are a local extension** (`extensions/subagents/`), not a built-in pi feature — look there for how they work, not in pi's upstream docs.
