---
name: specialist-design
description: "Craft guide for creating persistent, reusable agent definitions (.md files). Use when the user wants to create a new specialist agent, refine an existing one, or understand the agent definition format."
---

# Specialist Design

## Overview

Agent definitions are Markdown files that turn a generic pi agent into a focused specialist. Each definition declares a name, description, optional tool and skill filters, an optional model pin, and a system prompt. When referenced in the `subagent` tool's `agent` field, the definition shapes the spawned agent's identity — what it knows, what tools it sees, and how it behaves.

This skill covers how to write good definitions. For deciding *when* to use agents and *how* to orchestrate them, see the **orchestrating-agents** skill.

## Format Reference

An agent definition is a `.md` file with YAML frontmatter and a Markdown body.

```yaml
---
name: security-reviewer
description: "Reviews diffs for security vulnerabilities — injection attacks, auth bypasses, data exposure."
tools: read, bash, edit
skills: debugging
model: claude-sonnet
---
```

**Frontmatter fields:**

- **`name`** (required, string) — Unique identifier. Used in the `agent` field of the `subagent` tool. Files without a `name` are silently skipped during discovery.
- **`description`** (required, string) — What this agent does. Read by the orchestrator at group-design time to decide whether to use this specialist. Files without a `description` are silently skipped during discovery.
- **`tools`** (optional, comma-separated) — Filters available tools. Only the listed tools are visible to the agent. Omit to give the agent all available tools.
- **`skills`** (optional, comma-separated) — Skill names to make available. Resolved to filesystem paths via `resolveSkillPaths` at spawn time. When specified, the agent starts with `--no-skills` and only the listed skills are loaded (via `--skill` flags).
- **`model`** (optional, string) — Pins the agent to a specific model. Omit to use pi's configured default model.

**Body** — everything below the frontmatter is the system prompt, injected via `--append-system-prompt`. This is the agent's persistent identity: role, boundaries, behavioral rules. Write it as direct instructions to the agent.

Both `name` and `description` must be present or the file is silently skipped — no error, no warning. This is intentional; it lets you keep draft files in the agents directory without them polluting discovery.

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

Persistent identity. Role, boundaries, behavioral style, domain knowledge, output format preferences. Injected once when the agent spawns. This is what makes the agent a *specialist* rather than a generic agent with a task.

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
