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

## Steps

### Step 1: Create the orchestrating-agents skill

Create `skills/orchestrating-agents/SKILL.md` with frontmatter (`name: orchestrating-agents`, description targeting when the agent is about to design or spawn subagent groups) and body covering five sections:

1. **When to use subagents** — Decision criteria: parallelizable independent work, need for isolated contexts, specialist knowledge, user-mediated conversations. When *not* to: sequential work with heavy shared context, simple tasks that don't justify spawn overhead, work that needs the parent's full conversation history.

2. **Task decomposition** — How to carve work into agent-sized pieces. Writing effective task strings for default agents — each task string should carry identity ("You are a…") and mission ("Do X, produce Y, verify by Z"). Granularity guidance: too coarse wastes parallelism, too fine creates coordination overhead. Rule of thumb — each agent should produce a coherent, independently verifiable deliverable.

3. **Orchestration patterns** — Six patterns, each with when-to-use, lightweight pseudo-notation showing agent ids and channel declarations (not full `subagent` tool JSON), and communication flow description:
   - **Fan-out/fan-in** — independent parallel tasks, no peer channels, parent gathers results via `<agent_complete>`/`<group_idle>` notifications.
   - **Pipeline** — linear chain (`a→b→c`), each agent has a channel to the next, passes work forward via `send`.
   - **Collaborative team** — independent work with selective peer channels for lateral consultation. Most general pattern.
   - **Scatter-gather** — parent sends `send(expectResponse=true)` to multiple agents in the same turn, synthesizes responses.
   - **Persistent specialists** — long-lived group tapped on demand. Parent sends new work to idle agents; group stays alive across multiple exchanges.
   - **Iterative refinement** — produce/review/revise loop. Can be parent-driven (parent mediates each round) or peer-driven (producer and reviewer have mutual channels).

4. **Communication and topology design** — Four sub-topics:
   - **Topology:** Start minimal. Only declare peer channels where agents genuinely need lateral communication. Parent is always available — no need to declare it. Fan-out needs no peer channels; pipeline needs a linear chain; collaborative team needs selective connections based on expertise overlap. More channels = more noise.
   - **Fire-and-forget:** Default mode. Status updates, heads-ups, sharing intermediate findings, handing off work. Sender keeps working immediately.
   - **Blocking sends:** For questions that gate progress — sender's tool call stays open until the target calls `respond`. Use `send(expectResponse=true)`. For scatter-gather, call multiple blocking sends in the same turn.
   - **Deadlock awareness:** The broker detects cycles in blocking sends via DFS and rejects sends that would deadlock. Avoid designs where agents form blocking rings. If A blocks on B, B must not block on A (or on anyone who transitively blocks on A).

5. **Recursive subagents** — When a child should spawn its own sub-group. The lead agent pattern: parent spawns a lead with a broad mandate and the lead decomposes further into its own worker group using the same `subagent` tool. Child agents have the full tool suite. The parent sees the lead as a single agent; the lead's sub-group is invisible to the parent.

Follow the structural pattern of existing standalone skills (overview, process/guidance sections, key principles). Reference real tool parameters: `subagent` tool's `agents` array with `id`, `agent`, `task`, `channels`; `send` with `to`, `message`, `expectResponse`; `respond` with `correlationId`, `message`. Reference real notification XML: `<agent_complete>`, `<group_idle>`, `<agent_message>`. Ground topology guidance in actual behavior from `channels.ts` (parent auto-injected, `validateTopology` checks references) and `broker.ts` (channel enforcement, deadlock detection via `DeadlockGraph`).

Cross-reference the specialist-design skill for persistent agent definitions.

**Verify:** File exists at `skills/orchestrating-agents/SKILL.md`. Frontmatter has `name` and `description`. All five architecture sections present. Tool parameters, notification formats, and topology behaviors match the extension code.

**Status:** not started

### Step 2: Create the specialist-design skill

Create `skills/specialist-design/SKILL.md` with frontmatter (`name: specialist-design`, description targeting when the user wants to create or refine a persistent agent definition) and body covering four sections:

1. **Format reference** — The `.md` structure: YAML frontmatter with `name` (required string), `description` (required string), `tools` (optional, comma-separated tool names — filters available tools), `skills` (optional, comma-separated skill names — resolved to filesystem paths via `resolveSkillPaths`), `model` (optional string — pins the model; omit to inherit the parent's model). Body below the frontmatter is the system prompt, injected via `--append-system-prompt`. Both `name` and `description` must be present or the file is silently skipped during discovery (`loadAgentsFromDir` checks both).

2. **Where to put them** — `~/.pi/agent/agents/` for personal cross-project specialists (user scope). `.pi/agents/` in the repo for project-specific ones (project scope — discovery walks upward from cwd for the nearest `.pi/agents/` directory). The `agentScope` parameter on the `subagent` tool: `"user"` (default) searches only user dir, `"project"` searches only project dir, `"both"` searches both with project agents overriding user agents of the same name. The `confirmProjectAgents` parameter (default `true`) prompts before running project-local agents since they're repo-controlled.

3. **Authoring principles** — Craft guidance with inline good/bad illustrations woven into the text:
   - **One focused responsibility** — narrow scope means better instruction-following. A "code reviewer" that also refactors and writes tests is three agents pretending to be one.
   - **Explicit boundaries** — state what the agent does AND what it doesn't. Negative boundaries prevent scope creep. Example contrast: vague "helps with code" vs precise "reviews TypeScript for correctness and style; does not refactor, does not write new code."
   - **Description as routing metadata** — the `description` field is what the orchestrating agent reads to decide which specialist to invoke. Must be precise about capabilities and trigger conditions. Example contrast: "A helpful assistant" vs "Reviews diffs for security vulnerabilities, focusing on injection attacks, auth bypasses, and data exposure."
   - **Tool scoping as attention management** — `tools` filters what the agent sees. Fewer tools = less decision surface, better tool selection. A documentation writer doesn't need `bash`; a code reviewer doesn't need `write`.

4. **The description / system prompt / task string triad** — How the three pieces work together:
   - **Description** — routing metadata. Read at group-design time by the orchestrator, not at runtime. Must be self-contained.
   - **System prompt** (body) — persistent identity. Role, boundaries, behavioral style. Injected once at spawn.
   - **Task string** — per-invocation mission. Provided in the `task` field of the `subagent` call. Changes every invocation.
   - **What belongs where** — identity and behavioral rules in the system prompt; the specific job in the task string; routing precision in the description. Inline example showing the triad split correctly vs muddled (task-specific instructions baked into the system prompt, forcing a new definition per use).

Follow the structural pattern of existing standalone skills. Ground all format details in `agents.ts` (`AgentConfig` interface, `parseFrontmatter`, `buildAgentArgs` for how fields map to CLI flags, `discoverAgents` for scope resolution, `loadAgentsFromDir` for the silent-skip behavior).

Cross-reference the orchestrating-agents skill for orchestration patterns and task string guidance.

**Verify:** File exists at `skills/specialist-design/SKILL.md`. Frontmatter has `name` and `description`. All four architecture sections present. Frontmatter field names, file locations, and scope behavior match `agents.ts` and `index.ts`.

**Status:** not started

### Step 3: Commit

Stage both new skill files and commit with message: `feat: subagent companion skills`

**Verify:** Clean working tree. Commit contains exactly the two new SKILL.md files.

**Status:** not started
