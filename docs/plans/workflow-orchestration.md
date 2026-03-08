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

## Steps

**Pre-implementation commit:** `acb8cef82e9f270f2a867afffd7b5120aff83a98`

### Step 1: Create extension directory and package.json

Create `.pi/extensions/workflow/` with a `package.json` that declares the extension entry point via the `pi.extensions` field (same pattern as `extensions/azure-foundry/package.json`). No npm dependencies — `@mariozechner/pi-coding-agent`, `@sinclair/typebox`, and `@mariozechner/pi-ai` are resolved by pi's module system, and `node:fs`/`node:path` are built-ins.

**Verify:** `.pi/extensions/workflow/package.json` exists with `pi.extensions` pointing to `./index.ts`
**Status:** done

### Step 2: Write artifact inventory helper (`phases.ts`)

Create `.pi/extensions/workflow/phases.ts`. Export a `getArtifactInventory(): string` function that:

- Scans `docs/brainstorms/`, `docs/plans/`, `docs/reviews/` using `fs.readdirSync`
- Returns a formatted string listing the `.md` files found in each directory, grouped by directory
- Handles missing directories gracefully — returns an empty group for that directory, not an error
- Uses paths relative to `process.cwd()` (the project root at runtime)

Example output format:
```
docs/brainstorms/: auth-refactor.md, workflow-orchestration.md
docs/plans/: (none)
docs/reviews/: (none)
```

**Verify:** importing and calling `getArtifactInventory()` from a script in the project root returns a listing that includes existing brainstorm files and shows `(none)` for missing directories
**Status:** done

### Step 3: Write workflow prompt template (`prompt.md`)

Create `.pi/extensions/workflow/prompt.md`. This is the entry-point prompt, read as a resource file by the extension. Contains:

- The pipeline phase order: brainstorm → architect → plan → implement → review → handle-review
- A mapping of each phase to its skill name: brainstorm → `brainstorming`, architect → `architecting`, plan → `planning`, implement → `implementing`, review → `code-review`, handle-review → `handle-review`
- `${USER_INPUT}` placeholder — the user's freeform text from the `/workflow` command
- `${INVENTORY}` placeholder — the artifact listing injected by the extension
- Instructions to determine the topic and current phase by interpreting the inventory and user input: fuzzy-match the user's description against existing artifact filenames, infer which phase comes next from what artifacts exist, disambiguate with the user if multiple candidates match, or start fresh at brainstorm if nothing matches
- Instructions to load and follow the skill for the determined phase
- Instructions to call `workflow_phase_complete` with the topic slug and phase name when the skill's work is done
- Fallback read guidance: "Follow the skill's instructions for what to read. If you're uncertain about intent or context during a phase, you may consult earlier artifacts (brainstorm, plan) before asking the user — but don't read them by default."

Does **not** include a phase-continuation variant — that prompt is short enough to construct inline in TypeScript.

**Verify:** file exists, contains `${USER_INPUT}` and `${INVENTORY}` placeholders, references all six phases and their skill names
**Status:** not started

### Step 4: Write extension entry point (`index.ts`)

Create `.pi/extensions/workflow/index.ts`. This is the main extension file that wires everything together. Contains:

**Constants and helpers:**

- `PHASE_SKILL_MAP` — maps phase names to skill names: `{ brainstorm: "brainstorming", architect: "architecting", plan: "planning", implement: "implementing", review: "code-review", "handle-review": "handle-review" }`
- `PHASE_ORDER` — the ordered list of phases: `["brainstorm", "architect", "plan", "implement", "review", "handle-review"]`
- `FLEXIBLE_TRANSITIONS` — set of phase boundaries where the user chooses: `new Set(["brainstorm", "architect", "review"])` (the *completed* phase — brainstorm→architect, architect→plan, review→handle-review are flexible)
- `PHASE_ARTIFACTS` — maps each phase to its expected artifact path pattern for validation: brainstorm → `docs/brainstorms/${topic}.md`, architect → `docs/plans/${topic}.md`, plan → `docs/plans/${topic}.md`, implement → `docs/plans/${topic}.md`, review → `docs/reviews/${topic}.md`, handle-review → `docs/reviews/${topic}.md`
- `promptTemplate` — the contents of `prompt.md`, read via `fs.readFileSync(path.join(__dirname, "prompt.md"), "utf-8")` at module load time
- `buildEntryPrompt(userInput: string, inventory: string): string` — replaces `${USER_INPUT}` and `${INVENTORY}` in the template
- `buildPhasePrompt(topic: string, phase: string): string` — constructs a short inline prompt for transitions: establishes the topic, names the phase and skill to invoke, instructs to call `workflow_phase_complete` on completion, includes the fallback read guidance
- `getNextPhase(current: string): string | null` — returns the next phase from `PHASE_ORDER`, or `null` if `handle-review` (pipeline complete)

**`/workflow` command:**

Registered via `pi.registerCommand("workflow", ...)`. Handler:
1. Calls `getArtifactInventory()` from `phases.ts`
2. Calls `buildEntryPrompt(args, inventory)` where `args` is the user's freeform text (may be empty)
3. Sends the result via `pi.sendUserMessage(prompt)`

**`workflow_phase_complete` tool:**

Registered via `pi.registerTool(...)`. Parameters: `topic` (string) and `phase` (StringEnum of the six phase names). Execute function:
1. **Validate** — check that the expected artifact for this phase exists on disk using `fs.existsSync` with the path from `PHASE_ARTIFACTS`. If missing, throw an error (signals `isError: true` to the LLM) with a message like `"Expected artifact not found: docs/brainstorms/${topic}.md — complete the phase before signaling completion."`
2. **Next phase** — call `getNextPhase(phase)`. If `null`, return "Pipeline complete for topic ${topic}. All phases done." (no transition needed)
3. **Confirm** — call `await ctx.ui.confirm("Phase complete?", "Move on from ${phase} for ${topic}?")`. If user declines, return `"User indicated this phase isn't complete yet. Continue working."`
4. **Determine transition type** — check if `phase` is in `FLEXIBLE_TRANSITIONS`
5. **Flexible transition** — call `await ctx.ui.select("Context for next phase:", ["Continue in this context", "Start fresh context"])`. If continue: call `pi.sendUserMessage(buildPhasePrompt(topic, nextPhase), { deliverAs: "followUp" })` and return `"Phase complete. Continuing to ${nextPhase}."`. If fresh: call `pi.sendUserMessage("/workflow-new-session ${topic} ${nextPhase}", { deliverAs: "followUp" })` and return `"Phase complete. Starting fresh context for ${nextPhase}."`
6. **Mandatory transition** — call `pi.sendUserMessage("/workflow-new-session ${topic} ${nextPhase}", { deliverAs: "followUp" })` and return `"Phase complete. Starting fresh context for ${nextPhase}."`

**`/workflow-new-session` command:**

Registered via `pi.registerCommand("workflow-new-session", ...)`. Handler:
1. Parse `args` to extract `topic` and `nextPhase` (space-separated)
2. Call `await ctx.newSession()` — if cancelled, notify and return
3. Call `pi.sendUserMessage(buildPhasePrompt(topic, nextPhase))`

**Verify:** extension loads without errors when pi starts from the project root. `/workflow` appears in command list. `workflow_phase_complete` appears in tool list. `/workflow test` sends a user message containing the pipeline description and artifact inventory.
**Status:** not started

### Step 5: Update codemap

Add a **Workflow Extension** module to `codemap.md`:

- **Location:** `.pi/extensions/workflow/`
- **Responsibilities:** pipeline orchestration, artifact inventory scanning, phase transition management (flexible vs mandatory context boundaries), `/workflow` entry point command, `workflow_phase_complete` tool, session lifecycle for context clearing
- **Dependencies:** Skills (references skill names for phase routing)
- **Files:** `.pi/extensions/workflow/**`

Update the overview diagram to include the Workflow Extension module and its relationship to Skills.

**Verify:** codemap accurately reflects the new module and its relationships
**Status:** not started
