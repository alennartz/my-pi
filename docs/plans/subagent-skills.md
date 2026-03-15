# Plan: Subagent Companion Skills

## Context

Two companion skills for the subagents extension — one for orchestration (designing and spawning groups), one for specialist design (creating persistent agent definitions). The tool descriptions stay lean; these skills bring the deeper guidance into context on demand. See [brainstorm](../brainstorms/subagent-skills.md).

## Architecture

### Impacted Modules

**Skills** — Two new standalone skills added to `skills/`. Neither is part of the workflow pipeline. Loaded on demand when the agent is about to orchestrate or when the user wants to create a persistent specialist.

### New Modules

**Skill: orchestrating-agents** (`skills/orchestrating-agents/SKILL.md`)

Design-time reference for planning and spawning subagent groups. Loaded when the agent is about to use the subagent tools. Not a runtime guide — once the group is running, the tool descriptions and notifications carry the agent from there.

**Structure:**

1. **When to use subagents** — Decision criteria for reaching for subagents vs doing work directly. Parallelizable work, isolated contexts, specialist knowledge, user-mediated conversations. When *not* to — sequential work with heavy shared context, simple tasks that don't justify the overhead.

2. **Task decomposition** — Equal weight with patterns. How to carve up work into agent-sized pieces. Writing effective task strings that carry both identity and mission for default agents. Granularity guidance — too coarse wastes parallelism, too fine creates coordination overhead.

3. **Orchestration patterns** — Each pattern gets: when to use it, topology in lightweight pseudo-notation (not full JSON), brief description of communication flow. Patterns:
   - **Fan-out/fan-in** — independent parallel tasks, parent gathers results
   - **Pipeline** — linear chain, each stage feeds the next via peer channels
   - **Collaborative team** — independent work with lateral peer consultation as needed. Most general and powerful pattern.
   - **Scatter-gather** — parent queries multiple agents via blocking sends, synthesizes responses
   - **Persistent specialists** — long-lived group the parent or user taps on demand across multiple exchanges
   - **Iterative refinement** — produce/review/revise loop, parent-driven or peer-driven

4. **Communication and topology design** — How to design channel topology and choose messaging modes:
   - **Topology:** Start minimal. Only declare peer channels where agents genuinely need lateral communication. Parent is always available. Fan-out needs no peer channels; pipeline needs a linear chain; collaborative team needs mesh or selective connections based on expertise overlap. More channels = more noise.
   - **Fire-and-forget:** Mid-work notifications — FYI style messages where the sender keeps working. Status updates, heads-ups, sharing intermediate findings with a peer.
   - **Blocking:** Questions that gate progress — sender can't proceed without a response. Tool call stays open until target responds.
   - **Default to fire-and-forget** unless the sender genuinely can't continue without a response.

5. **Recursive subagents** — When a child should spawn its own sub-group. The lead agent pattern — parent spawns a lead with a broad mandate, lead decomposes further into its own worker group.

---

**Skill: specialist-design** (`skills/specialist-design/SKILL.md`)

Craft guide for creating persistent, reusable agent definitions (`.md` files). Loaded when the user wants to build a new specialist or refine an existing one.

**Structure:**

1. **Format reference** — The `.md` structure. Frontmatter fields: `name` (required), `description` (required), `tools` (comma-separated tool filter), `skills` (comma-separated skill names), `model` (optional). Body is the system prompt. What each field does.

2. **Where to put them** — `~/.pi/agent/agents/` for personal cross-project specialists. `.pi/agents/` in a repo for project-specific ones. User vs project scope, the `agentScope` parameter on the subagent tool, the confirmation prompt for project agents.

3. **Authoring principles** — Craft guidance for writing effective specialist definitions. Key principles:
   - **One focused responsibility** — Specialists do one thing well. Narrow scope means better instruction-following.
   - **Explicit boundaries** — State what the agent does AND what it doesn't. Negative boundaries prevent scope creep.
   - **Description as routing metadata** — The `description` field is what the orchestrating agent reads to decide which specialist to invoke. Must be precise about capabilities and scope, not vague.
   - **Tool scoping as attention management** — Fewer tools means less decision surface, better tool selection. Only include what the specialist needs.
   - Inline good/bad illustrations woven into the guidance (not a separate examples section).

4. **The description / system prompt / task string triad** — How these three pieces work together:
   - **Description** — routing metadata. How the orchestrator decides to use this specialist.
   - **System prompt** (body) — persistent identity. Role, boundaries, behavioral style. Doesn't change per invocation.
   - **Task string** — per-invocation mission. What to do this time. Provided at spawn time in the `subagent` call.
   - What belongs where — identity in the system prompt, mission in the task string, routing precision in the description.
