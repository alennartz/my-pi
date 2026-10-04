# Conventions

Repo working rules for `my-pi`. General rules that hold in every repo (dependency changes via package managers only, never bypass git hooks, don't fabricate, tone and style) live in `~/.pi/agent/AGENTS.md` and are not repeated here.

## Codebase

- Skills are Markdown files following the pi skill format (YAML frontmatter + structured sections).
- The extension uses TypeScript and imports from `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- **Never try to build, compile, or type-check this project.** Extensions are raw TypeScript loaded by pi at runtime — there is no build step, no `tsc`, no bundler. Editing the `.ts` files is the final step.
- Agent definitions are Markdown files in `agents/` with YAML frontmatter (name, description, tools, model) and a system prompt body.
- **Subagents are a local extension** (`extensions/subagents/`), not a built-in pi feature — look there for how they work, not in pi's upstream docs.
