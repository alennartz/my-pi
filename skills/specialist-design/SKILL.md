---
name: specialist-design
description: "Craft guide for creating persistent, reusable agent definitions (.md files). Use when the user wants to create a new specialist agent, refine an existing one, or understand the agent definition format."
---

# Specialist Design

## Overview

Agent definitions are Markdown files that turn a generic pi agent into a focused specialist. Each definition declares a name, description, optional tool and skill filters, an optional model pin, and a system prompt. When referenced in the `subagent` tool's `persona` field, the definition shapes the spawned agent's identity — what it knows, what tools it sees, and how it behaves. The same file shape can also be a working directory's `AGENTS.md` (via `kind: persona`) — see [Persona Sources and Precedence](#persona-sources-and-precedence).

This skill covers how to write good definitions. For deciding *when* to use agents and *how* to orchestrate them, see the **orchestrating-agents** skill. For writing skills (SKILL.md files) rather than agent definitions, see the **skill-writing** skill.

## Format Reference

An agent definition is a `.md` file with YAML frontmatter and a Markdown body.

```yaml
---
name: security-reviewer
description: "Reviews diffs for security vulnerabilities — injection attacks, auth bypasses, data exposure."
tools: read, bash, edit
skills: debugging
model: smart
---
```

**Frontmatter fields:**

- **`name`** (required, string) — Unique identifier. Used in the `persona` field of the `subagent` tool, and as the persona name of a `kind: persona` workspace `AGENTS.md`. Files without a `name` are silently skipped during discovery.
- **`description`** (required, string) — What this agent does. Read by the orchestrator at group-design time to decide whether to use this specialist. Files without a `description` are silently skipped during discovery.
- **`tools`** (optional, comma-separated) — Filters available tools. Only the listed tools are visible to the agent. Omit to give the agent all available tools.
- **`skills`** (optional, comma-separated) — Skill names to make available. Resolved to filesystem paths via `resolveSkillPaths` at spawn time. When specified, the agent starts with `--no-skills` and only the listed skills are loaded (via `--skill` flags). In root sessions the filter is softer — see the slash-command limitation under [Persona Sources and Precedence](#persona-sources-and-precedence).
- **`model`** (optional, string) — Pins the agent's model. Accepts a **tier name** (`cheap`, `medium`, `smart`, `frontier`) — the preferred vocabulary — or a concrete model id. Tier names resolve to concrete models at spawn time from the model-tiers config (`~/.pi/agent/model-tiers.json`, with a trusted-project `.pi/model-tiers.json` override); an unconfigured or unavailable tier falls back to the session default model. You may also append a thinking-effort suffix to any model id with `:<level>` (levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) — e.g. `anthropic/claude-opus-4-8:xhigh`. Tier names don't accept suffixes; a tier carries whatever level its config encodes. Omit the model field entirely to use the session default. (Use the `list_models` tool to see the full catalog when you need a specific model id.) The field is a **pin**: it wins over an explicit `model` argument on the `subagent` tool, which is gap-filling only — it applies when the active persona declares no `model`.

**Body** — everything below the frontmatter is the persona body. It *replaces* pi's default system-prompt preamble for the session that wears the persona (the `customPrompt` hook) — it does not stack under the generic persona. This is the agent's persistent identity: role, boundaries, behavioral rules. Write it as direct instructions to the agent. An explicit `--system-prompt` at launch outranks the ambient persona.

Both `name` and `description` must be present or the file is silently skipped — no error, no warning. This is intentional; it lets you keep draft files in the agents directory without them polluting discovery.

## Persona Sources and Precedence

An agent definition is a *persona*. Besides the agents directories above, a working directory's `AGENTS.md` can declare itself a persona with `kind: persona` front matter — same fields (`name` required, `description` optional for workspace declarations), same body semantics. Detection is strict: only `<cwd>/AGENTS.md` is consulted, exactly one directory deep — no ancestor walk, no subdirectory recursion. A file without the exact `kind: persona` marker (unknown `kind` values included) is not a persona and is left entirely alone as project context.

Persona sources are **exclusive**, in precedence order:

1. The cwd's `AGENTS.md` with `kind: persona` — a workspace persona.
2. The spawned persona: the definition named in the `subagent` tool's `persona` field. Applies only when (1) is absent.
3. Neither — the session has no persona.

One active persona per session, all or nothing. The winner is taken whole: a losing definition is discarded entire and its fields are never merged into the winner's. Fields absent from the active file fall through to pi's defaults — never to the discarded file's values. When a workspace persona overrides a spawned one, the session emits a transcript-visible notice naming both, so the orchestrator's belief about what it deployed is visibly corrected.

Persona presence is orthogonal to root-vs-subagent; all four combinations are valid:

| | Persona | Plain |
|---|---|---|
| **Root session** | Interactive specialist workspace: cd into the directory, launch pi, and the session *is* the specialist from the first message. | Ordinary pi session; a non-persona `AGENTS.md` stays project context. |
| **Subagent child** | The active persona's body replaces the child's preamble and its `model`/`tools`/`skills` bind at construction. A workspace persona at the child's cwd wins over the spawned definition. | Default general-purpose child (the `persona` field omitted). |

Two behaviors worth knowing:

- **Model pin precedence** — covered on the `model` field above: the active persona's pin wins, an explicit `model` spawn argument is gap-filling only.
- **Root skill filtering doesn't remove slash commands** — in root sessions, a declared `skills` list filters what the model sees per run, but unlisted skills' slash commands remain loaded: extensions can add skills at discovery but not subtract them. In subagent children the skill list is construction-locked (`--no-skills` plus exactly the declared skills).

## Where to Put Them

Agent definitions live in one of two directories:

- **`~/.pi/agent/agents/`** — User scope. Personal cross-project specialists. Available everywhere.
- **`.pi/agents/`** in a repo — Project scope. Discovery walks upward from the current working directory to find the nearest `.pi/agents/` directory.

The `agentScope` parameter on the `subagent` tool controls which directories are searched:

| Value | Searches |
|-------|----------|
| `"user"` (default) | User dir only |
| `"project"` | Project dir only |
| `"both"` | Both — project agents override user agents of the same name |

The `confirmProjectAgents` parameter (default `true`) prompts the user before running project-local agents, since those files are repo-controlled and could contain arbitrary instructions. Only trusted repositories should run without confirmation.

**When to use which scope:**

- **User scope** for general-purpose specialists you use across projects: a code reviewer, a documentation writer, a research assistant.
- **Project scope** for specialists that depend on project-specific context: a specialist that knows the project's architecture, coding conventions, or domain terminology.

## Authoring Principles

### One Focused Responsibility

A specialist does one thing well. Narrow scope means better instruction-following and more predictable behavior.

A "code reviewer" that also refactors, writes tests, and updates documentation is four agents pretending to be one. When the task string says "review this diff," an agent with a sprawling identity will be tempted to fix what it finds, write tests for edge cases it notices, and update the README while it's at it. A focused code reviewer examines and reports — that's it.

### Explicit Boundaries

State what the agent does AND what it doesn't. Positive descriptions define scope; negative boundaries prevent drift.

Vague: *"You help with code."*

Precise: *"You review TypeScript and JavaScript code for correctness, security, and style issues. You produce a structured list of findings with severity, location, and suggested fix. You do not apply fixes, write new code, or refactor existing code."*

The negative boundaries matter. Without them, an agent that *can* edit files (because you gave it `edit` in the tools list for reading context) will eventually *start* editing files because the task felt adjacent.

### Description as Routing Metadata

The `description` field is what the orchestrating agent reads when deciding which specialist to invoke. It's routing metadata, not a greeting.

Useless: *"A helpful assistant for code-related tasks."*

Useful: *"Reviews diffs for security vulnerabilities, focusing on injection attacks, auth bypasses, and data exposure. Expects a diff or file path in the task string."*

The description should answer: what does this agent do, what input does it expect, and when should an orchestrator reach for it? Be specific about capabilities and trigger conditions.

### Tool Scoping as Attention Management

The `tools` field isn't just about security — it's about focus. Every tool an agent sees is a decision it has to make (use this tool or not?) on every turn. Fewer tools means less decision surface and better tool selection.

A documentation writer doesn't need `bash`. A code reviewer that only reads and reports doesn't need `write`. A research agent that searches the web doesn't need `edit`.

When in doubt, start restrictive and widen if the agent hits a wall. It's easier to diagnose "agent needed a tool it didn't have" than "agent used a tool it shouldn't have."

## The Description / System Prompt / Task String Triad

Three pieces of text define an agent's behavior, and each serves a distinct purpose. Muddling them together produces agents that are either too rigid (task-specific instructions baked into the definition, requiring a new file per use case) or too vague (everything deferred to the task string, making the definition pointless).

### Description

Routing metadata. Read by the orchestrating agent at group-design time — never at runtime. Must be self-contained: the orchestrator should be able to decide whether to use this specialist based on the description alone, without reading the system prompt.

### System Prompt (Body)

Persistent identity. Role, boundaries, behavioral style, domain knowledge, output format preferences. It replaces pi's default system-prompt preamble for every session that wears the persona. This is what makes the agent a *specialist* rather than a generic agent with a task.

The system prompt should be **invocation-independent** — it describes *who the agent is*, not *what it's doing this time*. If you find yourself writing task-specific instructions in the body, they belong in the task string instead.

### Task String

Per-invocation mission. Provided in the `task` field of the `subagent` call. Changes every time the specialist is used. This is the *what* and the *where*: what to do, which files, what constraints apply this time.

### What Belongs Where

**Muddled** — task-specific instructions in the system prompt:

```yaml
---
name: api-reviewer
description: "Reviews API designs."
---
Review the REST API in src/api/routes.ts for consistency
with our naming conventions. Focus on HTTP methods and
path structure. Output a markdown table of findings.
```

This agent can only do one thing. Every new review target requires a new definition file.

**Clean** — identity in the system prompt, mission in the task string:

```yaml
---
name: api-reviewer
description: "Reviews REST API designs for consistency, naming conventions, and HTTP method correctness."
tools: read, bash
---
You are an API design reviewer. You evaluate REST APIs
for consistency, adherence to naming conventions, correct
HTTP method usage, and clean path structure.

Report findings as a markdown table with columns: endpoint,
issue, severity, suggestion. Be specific and actionable.
Do not modify any files.
```

Task string at spawn time: *"Review the REST API in `src/api/routes.ts`. Our naming conventions: kebab-case paths, plural resource names, no verbs in URLs."*

The definition is reusable. Different task strings point it at different APIs with different conventions.

## Key Principles

- **One responsibility per agent** — if the description needs "and" more than once, consider splitting.
- **Boundaries prevent drift** — state what the agent doesn't do, not just what it does.
- **Description is for the orchestrator** — precise routing metadata, not a friendly greeting.
- **Tools shape attention** — fewer tools means better focus. Start restrictive.
- **System prompt is identity, task string is mission** — keep them separate. Reusable definitions don't contain task-specific instructions.
- **Both `name` and `description` are required** — without either, the file is silently skipped during discovery.
