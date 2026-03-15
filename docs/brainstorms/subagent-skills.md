# Brainstorm: Companion Skills for the Subagents Extension

## The Idea

The subagents extension has a rich feature set — channels, messaging modes, agent definitions, recursive groups, idle detection, notifications — but the tool descriptions are intentionally lean (mechanics only). Two companion skills bring the deeper guidance into context on demand.

## Key Decisions

### Two skills, not one

The orchestration concern and the specialist authoring concern are cleanly separable. Writing effective task strings for one-off agents is part of orchestration. Writing persistent `.md` agent definitions involves a different set of concerns (frontmatter format, tool/skill scoping, model selection, file locations). Keeping them separate means each only loads when relevant.

### Orchestration skill owns task string craft

How to write a good task description for a default subagent is an orchestration concern — it's about "how do I describe work so a subagent performs well." It doesn't involve file formats, persistence, or frontmatter fields, so it belongs in the orchestration skill, not the specialist design skill.

### Specialist design skill is for persistence only

The specialist design skill is specifically for creating reusable agent definitions that live beyond the current session. No guardrail needed against accidental file creation — the skill only loads when someone explicitly asks to create a persistent agent. The skill boundary itself prevents accidental drift.

### Both are standalone skills

Neither is part of the workflow pipeline. Loaded on demand when the agent is about to orchestrate (orchestration skill) or when the user wants to create a persistent specialist (specialist design skill). The pipeline may be refactored to leverage subagents in the future, but that's a separate project.

## Direction

### Skill 1: Subagent Orchestration

Loaded when the agent is about to use or is already using the subagent tools. Covers:

- **When to use subagents** — parallelizable work, isolated contexts, specialist knowledge, user-mediated conversations. When *not* to — sequential work with heavy shared context, simple tasks that don't justify overhead.
- **Task decomposition and effective task strings** — how to carve up work, how granular to make tasks, how to write task descriptions that give subagents clear direction.
- **Orchestration patterns** — fan-out/fan-in, pipeline, mediator, persistent specialist pool, scatter-gather, iterative refinement. Each with a "when to use" and concrete example of the group shape (agents, channels).
- **Communication design** — fire-and-forget for status updates and handoffs, blocking for questions that gate progress. Peer channels for direct collaboration vs parent-mediated for centralized control. Deadlock awareness.
- **Recursive subagents** — when a child should decompose further. Lead agent pattern.
- **Lifecycle** — notification-driven flow (don't poll), keeping groups alive for reuse, sending follow-up work to idle agents, teardown when the group no longer serves a purpose.
- Cross-references specialist design skill for persistent agent definitions.

### Skill 2: Specialist Design

Loaded when the user wants to create or refine a persistent agent definition. Covers:

- **The `.md` format** — frontmatter fields (name, description, tools, skills, model), body as system prompt. What each field does.
- **Where files live** — `~/.pi/agent/agents/` for personal cross-project specialists, `.pi/agents/` in a repo for project-specific ones. User vs project scope, the `agentScope` parameter, the confirmation prompt for project agents.
- **System prompt craft** — role clarity, behavioral boundaries, what to include in the definition vs leave to the per-invocation task string. The relationship between the persistent prompt and the task.
- **Tool and skill scoping** — how `tools` filters available tools, how `skills` loads specific skills. When to constrain vs leave open.
- **Model selection** — when to pin a model (cost control, capability matching) vs leave it defaulting to the parent's model.

## Open Questions

- Naming: "subagent-orchestration" and "specialist-design" as skill names, or something shorter?
- How much example detail in the orchestration patterns — full `subagent` call JSON, or just prose descriptions of the topology?
- Should the orchestration skill include guidance on writing agent definitions for the *agents within the group* (i.e., when you want a specialist in your group but it's a one-off group), or strictly defer to the specialist design skill for anything involving `.md` files?
