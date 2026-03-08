# Workflow Orchestration

## The Idea

An orchestration system that ties the existing skill pipeline (brainstorm → architect → plan → implement → review → handle-review) into a coherent, automated workflow. The agent should follow the pipeline reliably from start to finish, with well-defined handoff artifacts between phases, managed context clearing at phase boundaries, and the ability to enter the pipeline at any step.

## Key Decisions

### Pipeline structure and context boundaries

The pipeline has two types of transitions:

- **Flexible transitions** (brainstorm → architect → plan): the user is prompted via a structured UI dialog to continue in the same context or start fresh. These phases are conversational and sometimes benefit from shared context, sometimes not.
- **Mandatory clears** (plan → implement, implement → review): always start a fresh context. Implementation and review need clean contexts — the artifacts carry everything forward.

```
[conversation 1+]  brainstorm → architect → plan  (prompted at each transition)
    ---- always clear ----
[conversation 2]   implement
    ---- always clear ----
[conversation 3]   review → handle-review
```

### No tracker file — skills are the tracker

The state of the pipeline is inferred from what artifacts exist, not from a separate status file:

- No brainstorm, no plan → starting fresh
- Brainstorm exists, no plan → architecting is next
- Plan exists with architecture, no steps → planning is next
- Plan exists with steps, none started → implementation is next
- Plan exists with steps all done, no review → review is next

The existing artifact paths (`docs/brainstorms/<topic>.md`, `docs/plans/<topic>.md`, `docs/reviews/<topic>.md`) already serve as the thread.

### Topic naming stays informal

The brainstorm naturally names the topic when it writes its artifact. No formalized topic registry. The LLM does fuzzy semantic matching when the user refers to an existing topic (e.g., "that auth thing" matches `docs/brainstorms/auth-refactor.md`).

### Flexible entry point

The user can enter the pipeline at any phase:

- `/workflow auth refactor` — fuzzy matches topic, picks up where artifacts say it left off
- `/workflow new: redesign the caching layer` — starts fresh at brainstorm
- `/workflow new: add retry logic, start at planning` — skips directly to planning

### The LLM doesn't know about context clearing

The agent has a single tool (`workflow_phase_complete`) that it calls to signal "I finished this phase." It passes the topic and which phase completed. It has no awareness of what happens next mechanically.

The extension handles all transition logic:

- Checks which phase just finished
- For flexible transitions: pops a structured UI select ("Continue here?" / "Fresh context?")
- For mandatory transitions: automatically creates a new session and injects the prompt template with the right topic and next phase

This uses `ctx.newSession()` (available in extension command handlers) to create fresh sessions and `pi.sendUserMessage()` to inject the prompt template invocation into the new context so it starts running automatically.

## Direction

Build two artifacts:

1. **Prompt template** (`.pi/prompts/workflow.md`) — gives the agent pipeline awareness: the phase order, how to detect current phase from existing artifacts, instructions to call `workflow_phase_complete` at transitions, and the skill to invoke for each phase.

2. **Extension** (`.pi/extensions/workflow.ts` or `.pi/extensions/workflow/`) — registers the `workflow_phase_complete` tool, contains the transition rules (which boundaries are flexible vs mandatory), handles UI prompts for flexible transitions, and does the `newSession()` + `sendUserMessage()` mechanics for context clearing.

## Open Questions

- Exact prompt template wording — how much pipeline context does the agent need vs. what the individual skills already provide?
- Should `/workflow` with no args list active topics (scan for existing brainstorms/plans) or just ask what to work on?
- Error recovery — what happens if the agent calls `workflow_phase_complete` prematurely, or a phase fails halfway? Does the extension need any rollback logic?
- Should the extension show a summary of what was accomplished in the previous phase when starting a fresh context, or is the artifact reference enough?
