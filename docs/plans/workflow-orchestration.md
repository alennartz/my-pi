# Plan: Workflow Orchestration

## Context

An orchestration system that ties the existing skill pipeline (brainstorm → architect → plan → implement → review → handle-review) into a coherent, automated workflow. The agent follows the pipeline reliably, with artifact-driven handoffs between phases, managed context clearing at phase boundaries, and natural-language entry at any point. See [brainstorm](../brainstorms/workflow-orchestration.md).

## Architecture

### New Modules

#### Workflow Extension (`.pi/extensions/workflow/`)

A directory-based pi extension that owns the entire orchestration feature. Contains:

- **`index.ts`** — entry point. Registers the `/workflow` command, the `/workflow-new-session` internal command, and the `workflow_phase_complete` tool. Contains transition logic (flexible vs. mandatory context boundaries).
- **`phases.ts`** — artifact inventory helper. Scans `docs/brainstorms/`, `docs/plans/`, `docs/reviews/` for existing files. Returns a simple file listing for prompt injection. No Markdown parsing, no state inference — the LLM interprets what the files mean.
- **`prompt.md`** — pipeline-awareness prompt stored as a Markdown resource file, read via `fs.readFileSync` at load time. Not a pi prompt template — an internal resource the extension owns and interpolates with topic/phase/inventory before sending.

### Interfaces

#### `/workflow` Command

Registered via `pi.registerCommand()`. Accepts freeform text — no structured syntax. The handler:

1. Scans artifact directories via `phases.ts` to build a file inventory
2. Interpolates the inventory + user text into `prompt.md`
3. Sends the result via `pi.sendUserMessage()`

The LLM interprets user intent: fuzzy-matches topics against existing artifacts, determines whether to continue an existing topic or start fresh, disambiguates with the user if multiple candidates match, and invokes the appropriate skill.

With no args, the LLM sees the inventory and either picks up the obvious in-progress topic or asks the user which one.

#### `workflow_phase_complete` Tool

Registered via `pi.registerTool()`. Parameters:

- `topic` — the filename slug (e.g. `"workflow-orchestration"`)
- `phase` — one of `"brainstorm"`, `"architect"`, `"plan"`, `"implement"`, `"review"`, `"handle-review"`

Execution flow:

1. **Validate** — verify the expected artifact exists on disk for the claimed phase. Return error to LLM if missing.
2. **Confirm** — ask the user via `ctx.ui.confirm()` whether the phase is actually done. If user says no, return "User indicated this phase isn't complete yet. Continue working."
3. **Transition** — based on transition type:
   - **Flexible** (brainstorm → architect, architect → plan): ask user via `ctx.ui.select()` whether to continue in same context or start fresh. If same context, send `pi.sendUserMessage()` with the next-phase workflow prompt directly. If fresh, queue `/workflow-new-session`.
   - **Mandatory** (plan → implement, implement → review): always queue `/workflow-new-session`.
4. **Return** — tell the LLM "Phase complete. Transition handled." The LLM has no awareness of session mechanics.

The tool cannot call `ctx.newSession()` (only available in `ExtensionCommandContext`), so new-session transitions go through the internal command.

#### `/workflow-new-session` Internal Command

Registered via `pi.registerCommand()`. An internal mechanism — not user-facing. Parameters passed as args string: `<topic> <next-phase>`.

1. Calls `ctx.newSession()`
2. Sends `pi.sendUserMessage()` with the workflow prompt interpolated for the given topic and phase

#### Prompt Content (`prompt.md`)

The prompt establishes three things:

1. **Topic identity** — "The topic is `${topic}`."
2. **Phase routing** — "You are in the `${phase}` phase. Invoke the `${skillName}` skill."
3. **Completion signal** — "When the skill's work is done, call `workflow_phase_complete` with the topic and phase."

Additionally:

- **Artifact inventory** (injected at `/workflow` entry only) — a listing of files in `docs/brainstorms/`, `docs/plans/`, `docs/reviews/` so the LLM can match topics and determine pipeline state.
- **Fallback read guidance** — "Follow the skill's instructions for what to read. If you're uncertain about intent or context during a phase, you may consult earlier artifacts (brainstorm, plan) before asking the user — but don't read them by default."

The prompt does not duplicate which artifacts each skill reads — the skills own that knowledge.

#### Transition Rules

| Completed Phase | Next Phase    | Transition Type |
|----------------|---------------|-----------------|
| brainstorm     | architect     | Flexible        |
| architect      | plan          | Flexible        |
| plan           | implement     | Mandatory clear |
| implement      | review        | Mandatory clear |
| review         | handle-review | Flexible        |
| handle-review  | (done)        | Pipeline complete |
