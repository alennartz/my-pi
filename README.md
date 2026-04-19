# alenna-pi

A personal [pi](https://github.com/badlogic/pi-mono) coding agent package — skills, extensions, agent definitions, prompt templates, and themes for my own workflow. Published as a pi package so others can install it or fork it as a starting point.

> **Security:** pi packages run with full system access. Extensions execute arbitrary code and skills can instruct the model to do anything on your machine. Read the source before installing.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed and on your `PATH`
- Node.js (for `npm install` of the package's own dependencies, which pi runs automatically on install)

## Install

Global install (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/alennartz/my-pi
```

Project-local install (writes to `.pi/settings.json` — shareable with a team):

```bash
pi install -l git:github.com/alennartz/my-pi
```

Pin to a ref:

```bash
pi install git:github.com/alennartz/my-pi@<tag-or-sha>
```

Try without installing (temporary, current run only):

```bash
pi -e git:github.com/alennartz/my-pi
```

From a local clone:

```bash
git clone https://github.com/alennartz/my-pi.git
pi install ./my-pi
```

Manage:

```bash
pi list                              # show installed packages
pi update                            # update non-pinned packages
pi remove git:github.com/alennartz/my-pi
```

See pi's [packages docs](https://github.com/badlogic/pi-mono) for the full install/enable/disable surface.

## What's Inside

### Workflow pipeline

A ten-phase development pipeline driven by the `/autoflow` command and a set of skills that hand off via artifacts in `docs/`:

`brainstorm → architect → test-write → test-review → impl-plan → implement → review → handle-review → manual-test → cleanup`

Brainstorm and architect are interactive; the remaining phases run autonomously via subagents, with the primary agent orchestrating transitions and validating artifacts between phases.

### Subagents

Long-lived subagent orchestration — spawn child pi processes, communicate over channels, fork sessions, await with interrupts. Ships with `orchestrating-agents` and `specialist-design` skills and a starter `scout` agent definition.

### Standalone skills

- `codemap` — generate/refresh a living map of the codebase
- `debugging` — structured root-cause investigation
- `decision-records` — write, number, and supersede DRs

### Extensions

- **subagents** — subagent lifecycle, channel messaging, TUI dashboard
- **azure-foundry** — auto-discovers Azure AI Foundry deployments as pi models
- **worktree** — `/worktree` command for git worktree-based branch sessions
- **session-resume** — detects interrupted sessions and injects resume markers
- **model-prompt-overlays** — appends `AGENTS.<model>.md` overlays to the system prompt based on the active model
- **toolscript** — runs [toolscript](https://github.com/badlogic/toolscript) as an MCP child and exposes its tools
- **user-edit** — `user_edit` tool that opens a file in pi's built-in editor
- **numbered-select** — TUI helper for numbered selection

### Prompts

- `onboard` — get oriented in an unfamiliar repo
- `tidy` — clean up working state

## Layout

```
agents/        agent definitions (subagent personas)
extensions/    TypeScript extensions, loaded at runtime (no build step)
prompts/       prompt templates
skills/        Markdown skills (YAML frontmatter + body)
themes/        pi themes
lib/           shared TS helpers used by extensions
docs/          brainstorms, plans, reviews, manual tests, decision records
codemap.md     full module map (read this for the deeper tour)
```

See [codemap.md](./codemap.md) for module responsibilities, dependencies, and file ownership.

## Notes for Contributors / Forkers

- Extensions are **raw TypeScript** loaded by pi at runtime — no build, no `tsc`, no bundler. Edit `.ts` files directly.
- Skills are Markdown with YAML frontmatter following pi's skill format.
- Agent definitions are Markdown with YAML frontmatter (`name`, `description`, `tools`, `model`) plus a system prompt body.
- Subagents are a **local extension** (`extensions/subagents/`), not a built-in pi feature.

## License

MIT — see [LICENSE](./LICENSE).
