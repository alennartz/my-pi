# Agents

## Vision

`my-pi` is my personal pi package: the workflow pipeline (brainstorm → architect → test-write → test-review → impl-plan → implement → review → handle-review → manual-test → cleanup), the standalone skills and specialist agents I reach for daily, and the extensions that make pi behave the way I want. It is authored for one user and must stay legible to a future me: new capability lands as a skill, agent, or extension with a codemap entry — never as instruction text piled into this file.

## Lookup

| File | What you'll find there |
|---|---|
| [codemap.md](./codemap.md) | Every module: responsibilities, dependencies, owned files. Start here before touching code. |
| [docs/conventions.md](./docs/conventions.md) | Repo working rules — never build/type-check this project, skill and agent-definition formats, subagents-are-local. |
| `~/.pi/agent/AGENTS.md` | Global working rules that hold in every repo — dependency changes via package managers only, never bypass git hooks, don't fabricate, tone and style. |
| `skills/*/SKILL.md` | Per-skill doctrine (skill-writing, codebase-design, debugging, codemap, …). |
| `agents/*.md` | Specialist agent definitions (name, model, tools, system prompt). |
| [docs/decisions/](./docs/decisions/) | Decision records for significant choices. |
| [docs/plans/](./docs/plans/) | Implementation plans produced by the workflow pipeline. |
| [docs/pi-internals/](./docs/pi-internals/) | Notes on pi's own extension/session internals. |
| [docs/research/](./docs/research/) | Research grounding for design decisions. |
