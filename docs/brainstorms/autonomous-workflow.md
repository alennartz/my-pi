# Brainstorm: Autonomous Workflow

## The Idea

Make the development workflow pipeline run with minimal human intervention. Currently every phase transition requires manual confirmation (numbered select prompts) and mandatory context resets require the user to press Enter to send a pre-filled command. The goal is to reduce this to only the interactions that genuinely need human input.

## Key Decisions

### Interactive vs. autonomous phases

Brainstorm and architect stay fully interactive — these are conversational phases where the user is actively participating. All other phases (test-write, test-review, impl-plan, implement, review, handle-review, cleanup) run autonomously via subagents. Test-review and cleanup may occasionally escalate to the user when something is genuinely ambiguous, but the default is autonomous.

**Why:** The user's input is most valuable during problem exploration and design. Execution phases mostly just follow the plan, and rubber-stamping transitions adds friction without value.

### Subagents for context boundaries

Each autonomous phase runs as a subagent, which naturally provides a clean context. This replaces the current session-switching mechanism (`pendingTransition` + editor pre-fill + `/internal-workflow-next`) for autonomous phases. Mandatory context boundaries (DR-008, DR-024) are preserved structurally — subagents can't share conversational context by design.

**Why:** Subagents solve two problems at once — autonomous execution and clean context boundaries. No need for session-management plumbing when the isolation is architectural.

### Primary agent as orchestrator with a skill

The primary agent loads an orchestration skill that guides the entire pipeline. It handles brainstorm and architect directly, then spawns sequential subagents for execution phases. After each subagent completes, the primary evaluates the result using the skill's decision guidance — move to next phase, re-review, skip, or escalate. The primary is *not* a specialist agent definition (it's the main user-facing agent), so a skill is the right vehicle for the guidance.

**Why:** The primary agent is already in conversation with the user during the interactive phases. Having it orchestrate the rest keeps the pipeline in one place and gives it the context to make good transition decisions.

### Transition decisions made by the primary

The orchestration skill encodes heuristics for transition decisions that the user currently makes manually: when to proceed, when to request an extra review pass, when to skip phases, how to handle failures. The primary applies these heuristics and can always escalate to the user when uncertain.

**Why:** Most transition decisions are routine. The skill gives the primary enough judgment to handle the common cases, and escalation covers the rest.

### Completion signaling via agent completion, not tools

Subagents do not use `workflow_phase_complete`. Instead, completion is structural: subagents are prompted to always use blocking sends to parent for clarification (so they never complete while needing help). Normal agent completion means the phase is done. The parent validates by checking artifacts.

If a subagent's final message indicates it wasn't actually done, the parent can send it back to continue or spawn a fresh attempt. No special signaling mechanism needed.

**Why:** This is more robust than tool-based signaling. Completion is unambiguous — the subagent either finished or it's still talking. `workflow_phase_complete` solved the "am I really done?" problem for the interactive model; the subagent model solves it structurally.

### `workflow_phase_complete` left as-is for interactive phases

The tool stays registered and available. The autonomous entry point's orchestration skill doesn't reference it, so the primary shouldn't invoke it during autonomous operation. The tool's `promptSnippet` is visible in the system prompt but the skills (brainstorming, architecting) don't mention it, and the orchestration skill's instructions for interactive phases won't either. If this proves unreliable in practice, we can make registration conditional on workflow mode.

**Why:** The traditional `/workflow` still needs it. Keeping it avoids changes to the existing system while the autonomous version is developed alongside it.

### New entry point, coexisting with `/workflow`

The autonomous workflow gets a new command (separate from `/workflow`). Both coexist — the traditional workflow remains fully functional while the autonomous version is developed and validated.

**Why:** De-risks the change. The existing workflow is battle-tested; the autonomous version can be iterated on without breaking what works.

## Direction

Build an orchestration skill and a new entry-point command. The skill guides the primary agent through interactive phases, then through spawning and evaluating subagents for execution phases. Each subagent gets the relevant skill instructions and topic context. The primary makes transition decisions using encoded heuristics, escalates to the user when uncertain, and validates artifacts between phases. Subagents use blocking sends for clarification and normal completion to signal they're done.

## Open Questions

- **Entry point command name** — `/auto-workflow`, `/autopilot`, `/workflow-auto`, or something else?
- **Orchestration skill granularity** — how detailed should the transition heuristics be? Start minimal and iterate, or try to encode most decision criteria upfront?
- **Failure recovery depth** — how aggressively should the primary retry or debug failed phases before escalating? Needs experimentation to calibrate.
- **Skip decisions** — the current workflow offers skip options (brainstorm → impl-plan, brainstorm → implement). Should the orchestration skill support these, or are they less relevant when the overhead of running phases is lower (no manual gates)?
