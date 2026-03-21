# Scout Agent

## The Idea

A read-only codebase exploration agent that saves parent tokens. The parent delegates "find me the relevant files/sections for X" to scout, which runs on a cheaper/faster model, explores the codebase, and returns prose with file references (paths + line ranges) so the parent can surgically read only what matters.

## Key Decisions

- **Read-only toolset: `read`, `bash`, `send`** — scout never modifies the codebase. `edit`, `write`, and subagent tools are excluded. `send` is only for asking the parent clarifying questions mid-exploration, not for returning results.
- **Results via natural completion, not `send`** — scout's final output is its end-of-turn text, which the subagent system delivers to the parent automatically. No structured protocol needed.
- **Output format: prose + file references** — not a rigid schema. Scout returns reasoning, context, and answers with embedded file paths and line ranges as supporting references. The balance of prose vs. references depends on the task (a focused lookup is mostly references; an analytical question is mostly prose).
- **Codemap-first orientation** — scout checks for `codemap.md` in the working directory and reads it first if present. If absent, it proceeds directly to exploration. This gives it a map of the territory without requiring the parent to pass it in.
- **Handles both focused and open-ended tasks** — from "find the files that handle X" to "what would I need to touch to add Y?" Scout explores and reasons about relationships, not just locates files.
- **Cheap/fast model** — the whole point is token savings for the parent. The agent definition will pin a cheaper model. Today that means an Azure Foundry deployment name (deployment names are used as model IDs — see the azure-foundry extension).
- **No recursive subagents** — scout is a leaf agent. It doesn't spawn sub-groups.

## Direction

Create a single agent definition `.md` file in the project's agents directory. The definition needs:
- Frontmatter: name, description, tools (`read, bash, send`), model pin
- System prompt: instructs scout to check for codemap, explore thoroughly, return prose + file references with line ranges, use `send` only for clarification

## Open Questions

- **Which model to pin** — depends on what's deployed in Azure Foundry. The definition should use the deployment name for the cheap/fast model available at the time.
- **Where to put the agent file** — needs to be in a directory the subagent extension discovers (project agents dir or user agents dir). Check where the extension looks.
