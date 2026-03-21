# Plan: Scout Agent

## Context

A read-only codebase exploration agent distributed via the `alenna-pi` package. Scout saves parent tokens by running on a cheap/fast model, exploring the codebase, and returning prose with file references so the parent can surgically read only what matters. See [brainstorm](../brainstorms/scout-agent.md).

## Architecture

### Impacted Modules

**Subagents** — no code changes. Scout is discovered through the existing agent discovery pipeline (`discoverPackageAgents` reads `pi.agents` from the package manifest, `loadAgentsFromDir` loads `.md` files from declared directories). The four-tier merge makes it available wherever the package is installed.

**Docs** — the plan artifact lives here as usual. No structural change.

### New Modules

**Agents** — a new top-level `agents/` directory containing agent definition `.md` files distributed by the package. First inhabitant: `scout.md`. Discovered via the `pi.agents` manifest key, which the subagents extension already supports (DR-016). The directory is declared in `package.json` under `pi.agents`.

### Interfaces

The agent definition format is already established by the subagents extension:

- **Frontmatter fields:** `name`, `description`, `tools` (comma-separated), `model` (deployment name used as model ID by azure-foundry)
- **Body:** system prompt text, injected by the subagents extension at spawn time

Scout's specific interface with the parent:

- **Input:** task description passed by the parent when spawning
- **Output:** natural completion text (prose + file paths with line ranges) — delivered to the parent automatically by the subagent system
- **Mid-task communication:** `send` to parent for clarifying questions only, not for returning results

Scout's frontmatter:

- `name: scout`
- `description:` concise summary of read-only codebase exploration for token savings
- `tools: read, bash, send`
- `model: genitsec-haiku-4-5`

Scout's system prompt covers:

- **Codemap-first orientation** — check for `codemap.md` in the working directory, read it first if present, proceed directly to exploration if absent
- **Exploration approach** — use `bash` for grep/find/ls to locate, `read` for targeted file sections; read enough to answer thoroughly, not everything
- **Output shape** — prose with embedded file paths and line ranges as supporting references; balance depends on the task (focused lookup → mostly references, analytical question → mostly prose)
- **Clarification via `send`** — use only for mid-task questions to the parent when the task is ambiguous; results come via natural completion
- **No modification** — never suggest or attempt code changes; scout observes and reports

## Steps

### Step 1: Create `agents/scout.md`

Create the `agents/` directory at the repo root and add `scout.md` with frontmatter (`name: scout`, `description`, `tools: read, bash, send`, `model: genitsec-haiku-4-5`) and a system prompt covering: codemap-first orientation, exploration approach using `bash` and `read`, prose + file references output with line ranges, `send` for clarification only, and read-only stance.

**Verify:** File exists at `agents/scout.md`, frontmatter parses correctly (has all required fields), body contains the system prompt.
**Status:** not started

### Step 2: Register agents directory in `package.json`

Add `"agents": ["./agents"]` to the `pi` section of `package.json`.

**Verify:** `pi.agents` key is present in `package.json` and points to `./agents`. Scout is discoverable when the subagents extension runs `discoverPackageAgents`.
**Status:** not started
