# Brainstorm: Workflow–Subagent Integration

## The Idea

Embed subagent orchestration hints directly in workflow skill prose so the primary agent naturally delegates work instead of doing everything itself. Two pain points drive this: long implementations exhaust the primary's context window, and phases with independent work run sequentially when they could parallelize.

## Key Decisions

### 1. "Scout" as a verb trigger

Skills use the word "scout" (as a verb) where investigation should be delegated to a scout agent — e.g., "scout the impacted modules" instead of "read the impacted modules." The primary sees the verb and knows to spawn a scout agent rather than reading files itself. No structural changes to skill format; just a vocabulary shift in the right places. Scouts return prose with file references so the primary can surgically read only what matters.

**Why:** The scout agent definition already exists — cheap model, read-only, returns prose with references. This is exactly what investigation phases need. A verb trigger keeps the skill prose natural and avoids inventing a new config format.

### 2. Implementing: primary as orchestrator, module-aligned workers

The primary reads the plan, groups work by impacted module (natural from the architecture section + codemap), and spawns worker agents with inter-agent channels. Workers communicate via channels to unblock dependencies — agent-B doesn't wait for agent-A to finish, it waits for agent-A to produce the interface it needs. The primary owns plan status updates and commits, updating between batches/phases.

**Why:** The architecture and plan already organize work by module. Module-aligned agents with channels turn step dependencies from a serialization problem into a communication problem, enabling concurrency even when steps aren't fully independent. The primary stays clean as orchestrator — never reads source files, never writes code — so it can manage long features without exhausting context.

### 3. Code review: parallelize the two passes

Plan adherence and code correctness are already defined as separate phases in the skill. Run them as two parallel subagents on the same diff. Each produces findings; the primary merges into one review document.

**Why:** The two passes are independent — they read the same diff but look for different things. No reason to serialize them.

### 4. Cleanup: primary on DRs, background delegation for the rest

DR extraction stays with the primary because it frequently needs user interaction (proposal flow). Codemap refresh and documentation pass fan out to subagents concurrently in the background while the primary works on DRs.

**Why:** DR extraction is conversational; codemap and doc refresh are context-heavy but autonomous. Running them in parallel with the primary's DR work saves wall-clock time.

### 5. Remove "pure linear order" language from planning

The planning skill currently says "pure linear order — no parallel annotations, no dependency graphs." Remove this. The implementer decides parallelism at runtime based on module boundaries and step dependencies. The planner doesn't need to predict it.

**Why:** Parallelism is an execution concern, not a planning concern. The plan already contains enough information (module ownership, file references, interfaces) for the implementer to judge independence.

### 6. No subagent hints for brainstorming or handle-review

Brainstorming is conversational — the value is in the dialogue with the user. Handle-review fixes are small and surgical; the overhead of spawning agents exceeds the work.

### 7. Review reads its own files — scouts don't fit

Code review needs to see actual code to judge correctness. Prose summaries from scouts would lose the detail that matters. Scouts are for investigation (understanding what exists), not for evaluation (judging whether code is correct).

## Direction

Edit each workflow skill to add orchestration hints in its prose:

- **Architecting** — scout verbs in the investigation phase (step 1)
- **Planning** — scout verbs in the investigation phase (step 1)
- **Implementing** — module-aligned collaborative team pattern; primary as orchestrator; remove sequential-only assumptions
- **Code review** — parallel passes hint
- **Cleanup** — background fan-out for codemap/docs while primary handles DRs
- **Planning format** — remove "pure linear order" constraint

## Open Questions

- Exact wording and placement of hints within each skill — needs the architecture phase to determine where they fit without disrupting the existing skill flow.
