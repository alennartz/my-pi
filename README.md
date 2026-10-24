# alenna-pi

A personal [pi](https://github.com/badlogic/pi-mono) coding agent package. It adds a development workflow pipeline, subagent orchestration, standalone skills, extensions, prompt templates, and agent definitions to pi.

> **Security:** pi packages run with full system access. Extensions execute arbitrary code. Skills can instruct the model to do anything on your machine. Read the source before installing.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed and on your `PATH`
- Node.js

## Install

Global install (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/alennartz/my-pi
```

Project-local install (writes to `.pi/settings.json`, shareable with a team). Pi loads it only after you grant project trust:

```bash
pi install -l git:github.com/alennartz/my-pi
```

Pin to a tag or commit:

```bash
pi install git:github.com/alennartz/my-pi@<tag-or-sha>
```

Try it for the current run only, without installing:

```bash
pi -e git:github.com/alennartz/my-pi
```

From a local clone. Pi installs dependencies automatically for git sources but not for local ones, so run `npm install` yourself:

```bash
git clone https://github.com/alennartz/my-pi.git
cd my-pi
npm install
cd ..
pi install ./my-pi
```

Manage:

```bash
pi list                                  # show configured packages
pi update --extensions                   # update all installed packages
pi remove git:github.com/alennartz/my-pi
```

Pinned refs stay pinned across updates. See pi's [documentation](https://github.com/badlogic/pi-mono) for the full package surface.

## What's Inside

### Workflow pipeline

A ten-phase development pipeline driven by the `/skill:autoflow` command:

`brainstorm → architect → test-write → test-review → impl-plan → implement → review → handle-review → manual-test → cleanup`

```bash
/skill:autoflow <description of what you want to build or change>
```

Brainstorm and architect run interactively with you. The remaining phases run autonomously in subagents. Each phase writes an artifact under `docs/`, and the next phase consumes it.

To have every new session start in autoflow, opt in via `~/.pi/agent/autoflow.json`:

```json
{ "autoStart": true }
```

Pi then delivers your first message in a new session as an autoflow invocation with that message appended, exactly as if you had invoked it yourself. Set `"command"` in the same file to use a different invocation (default `"/skill:autoflow"`).

### Subagents

The `subagents` extension provides long-lived subagent orchestration. Its tools spawn child pi sessions (optionally in their own working directories), communicate over channels, fork and resurrect sessions, and await with interrupts. A dashboard shows their status.

Subagent calls and agent definitions accept model tier names (`cheap`, `medium`, `smart`, `frontier`). Map tiers to model IDs in `~/.pi/agent/model-tiers.json`, or `.pi/model-tiers.json` for a single project.

Two agent definitions ship with the package:

- `scout` — read-only codebase search
- `comment-sicko` — a reviewer that savors deleting comments and condemns workaround code

### Skills

Invoke any skill with `/skill:<name>`. The standalone skills:

- `codemap` — generate or refresh a living map of the codebase
- `debugging` — structured root-cause investigation
- `decision-records` — write, number, and supersede decision records
- `codebase-design` — design doctrine for modules and functions
- `domain-modeling` — build and sharpen a project's domain language
- `improve-code` — scan a codebase for deepening opportunities and work through them
- `orchestrating-agents` — patterns for delegating work to subagents
- `skill-writing` — guidance for writing and editing skills
- `specialist-design` — guidance for creating agent definitions

The pipeline phase skills are hidden from the model. Only autoflow drives them.

### Extensions

- **subagents** — subagent lifecycle, channel messaging, TUI dashboard
- **persona-workspaces** — an `AGENTS.md` with `kind: persona` turns the working directory into a named specialist, with model, tool, and skill bindings
- **web-tools** — `web_search` (Brave; requires `BRAVE_API_KEY`) and `web_fetch`
- **quota-providers** — quota-aware model providers with a `/quota` command and a status footer. Built-in Azure Foundry and DevPass providers. Config at `~/.pi/agent/quota-providers.json`.
- **worktree** — `/worktree` command for git worktree-based branch sessions
- **session-resume** — detects interrupted sessions and injects resume markers
- **autoflow-autostart** — opt-in autoflow invocation on the first message of a new session (see above)
- **session-name** — `set_session_name` tool so the model can name the current session
- **model-prompt-overlays** — appends `AGENTS.<model>.md` overlays to the system prompt based on the active model
- **toolscript** — runs [toolscript](https://github.com/badlogic/toolscript) as an MCP child and exposes its tools
- **user-edit** — `user_edit` tool that opens a file in pi's built-in editor
- **ask-user** — `ask_user` tool for single-choice questions
- **print-prompt** — `/sysprompt` command to inspect the last rendered system prompt
- **my-pi-docs** — injects a system-prompt pointer to the extension configuration reference

### Prompts

Prompt templates run as slash commands:

- `/tidy` — commit and push the checked-out branch
- `/experiment` — run a goal-driven single-variable experiment campaign
- `/resolve-conflicts` — resolve a git merge or rebase conflict by intent

## Configuration

Each extension owns its configuration files and environment variables. The full reference is [`docs/extensions.md`](./docs/extensions.md). It documents every config file, front-matter field, default, and environment variable.

## License

MIT — see [LICENSE](./LICENSE).
