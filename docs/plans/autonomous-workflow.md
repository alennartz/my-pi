# Plan: Autonomous Workflow

## Context

Make the workflow pipeline run with minimal human intervention. Brainstorm and architect stay interactive; all subsequent phases run autonomously via subagents orchestrated by the primary agent following a new skill. See brainstorm: `docs/brainstorms/autonomous-workflow.md`.

## Architecture

### Impacted Modules

**Workflow** — A new skill (`skills/autoflow/SKILL.md`) is added to drive the autonomous pipeline. The existing workflow extension (`extensions/workflow/index.ts`) gets a small guard: `workflow_phase_complete` tool registration is wrapped in `if (!process.env.PI_PARENT_LINK)` so it doesn't register in subagent processes. No other changes to the extension — the `/workflow` command and all its machinery remain untouched.

**Skills (pipeline)** — The nine phase skills are unchanged. Subagents load and follow them the same way the primary agent does today. The only difference is that subagents don't call `workflow_phase_complete` (the tool won't be registered, and nothing in the skills references it — only the workflow prompt template does).

**Subagents** — Used as-is. No changes needed. The primary agent uses the existing `subagent`, `await_agents`, `send`, and `respond` tools to orchestrate phase execution.

### New Modules

**Autoflow skill** (`skills/autoflow/SKILL.md`) — Orchestration skill that guides the primary agent through the full pipeline. Invoked via `/autoflow` (skills automatically get slash commands from pi). Owns:

- **Interactive phase execution**: instructs the primary to run brainstorm and architect directly, following those skills in conversation with the user.
- **Autonomous phase orchestration**: after architect completes, the primary spawns sequential subagents for each remaining phase. Each subagent gets a task string containing: which skill to follow, the topic, and the invariant to use blocking sends to parent for clarification rather than stopping.
- **Transition heuristics**: what artifact to check after each subagent completes, and the default action (proceed). Phase-specific guidance:
  - After handle-review: re-review if the review contained structural findings or multiple major/critical issues. Otherwise proceed to cleanup.
  - After any phase: if the subagent completed but the expected artifact is missing or the final message indicates failure, retry with one fresh subagent. If that also fails, escalate to the user.
- **Skip decisions**: after architect, the primary may skip ahead based on scope:
  - Skip to impl-plan (bypass test-write and test-review) for small, straightforward changes.
  - Skip to implement (bypass test-write, test-review, and impl-plan) for very small changes.
  - When skipping, the primary writes scaffold sections to the plan file (using the same "Skipped" marker format the existing workflow uses) and commits before spawning the target phase.
  - If uncertain whether to skip, ask the user.
- **Escalation**: the primary can always surface questions or problems to the user. Subagents escalate to the primary via blocking sends; the primary relays to the user when it can't resolve itself.

### Interfaces

**Autoflow skill → Primary agent**: The skill is a Markdown file loaded by the primary agent. No programmatic interface — the skill's instructions guide the agent's behavior through natural language.

**Primary → Subagents (task string contract)**: Each autonomous phase subagent receives a task string with:
```
- Skill reference: which skill file to read and follow (e.g., skills/test-writing/SKILL.md)
- Topic: the filename slug (e.g., "worktree-management")
- Clarification invariant: "If you need clarification or encounter ambiguity, send a blocking message to parent. Do not stop without completing the phase."
```

**Subagent → Primary (completion signaling)**: Structural, not tool-based. A subagent that completes normally signals phase completion. A subagent that needs help sends a blocking message (`send(to="parent", expectResponse=true)`) and waits for the primary's response. The primary receives these as `<agent_message>` interrupts during `await_agents`.

**Primary → Artifacts (transition validation)**: After each subagent completes, the primary checks:
| Phase | Artifact check |
|-------|---------------|
| test-write | `docs/plans/<topic>.md` contains `## Tests` section |
| test-review | `docs/reviews/<topic>-tests.md` exists |
| impl-plan | `docs/plans/<topic>.md` contains `## Steps` section |
| implement | `docs/plans/<topic>.md` has no pending steps |
| review | `docs/reviews/<topic>.md` exists |
| handle-review | `docs/reviews/<topic>.md` exists (re-review decision based on review content, not artifact presence) |
| cleanup | Plan file (`docs/plans/<topic>.md`) and review files (`docs/reviews/<topic>.md`, `docs/reviews/<topic>-tests.md`) removed |

**Primary → Plan file (skip scaffolding)**: When skipping phases, the primary writes scaffold sections to `docs/plans/<topic>.md` using the established "Skipped" marker format:
- `## Architecture` with skip note (only when skipping from brainstorm — not applicable here since architect is always interactive)
- `## Tests` with skip note
- `## Steps` with skip note (only when skipping to implement)

Commits the scaffolded plan before spawning the target phase's subagent.

### DR Supersessions

None. The autonomous workflow coexists with the traditional workflow — no existing decisions are superseded. DR-008 (context boundaries) is preserved structurally via subagents rather than session switching, but the principle and the boundary locations are unchanged.

## Tests

**Pre-test-write commit:** `0cb20382b7c1fc11d6fc6fdc41d34d1dd6d8e63c`

### Interface Files

- `extensions/workflow/autoflow-checks.ts` — `TransitionCheckResult` type, `CheckablePhase` type, and `checkTransitionArtifact()` function stub. Formalizes the architecture's artifact validation table as a callable contract.

### Test Files

- `extensions/workflow/autoflow-checks.test.ts` — Behavioral tests for the transition artifact validation contract across all autonomous phases.

### Behaviors Covered

#### Transition Validation — Non-checkable Phases

- Returns null for brainstorm (interactive, no artifact check)
- Returns null for architect (interactive, no artifact check)
- Returns null for unrecognized phase names

#### Transition Validation — test-write

- Passes when the plan file contains a `## Tests` section
- Fails when the plan file does not exist
- Fails when the plan file exists but has no `## Tests` section

#### Transition Validation — test-review

- Passes when the test review file (`docs/reviews/<topic>-tests.md`) exists
- Fails when the test review file does not exist

#### Transition Validation — impl-plan

- Passes when the plan file contains a `## Steps` section
- Fails when the plan file does not exist
- Fails when the plan file exists but has no `## Steps` section

#### Transition Validation — implement

- Passes when all steps have `**Status:** done`
- Fails when any step has a non-done status (in progress, not started, blocked)
- Fails when the plan file does not exist
- Fails when the plan file has no `## Steps` section

#### Transition Validation — review

- Passes when the review file (`docs/reviews/<topic>.md`) exists
- Fails when the review file does not exist

#### Transition Validation — handle-review

- Passes when the review file exists
- Fails when the review file does not exist

#### Transition Validation — cleanup

- Passes when plan and review files have all been removed (working artifacts cleaned)
- Fails when the plan file still exists
- Fails when the code review file still exists
- Fails when the test review file still exists

#### Result Shape

- Always returns a `passed` boolean and non-empty `detail` string on success
- Always returns a non-empty `detail` string on failure

**Review status:** approved

## Steps

**Pre-implementation commit:** `42017c6b7051a463c6d0251c69ca6a6623276248`

### Step 1: Implement `checkTransitionArtifact()`

Replace the `throw new Error("not implemented")` body in `extensions/workflow/autoflow-checks.ts` with the actual transition validation logic. The function takes `phase`, `topic`, and `cwd` and returns `TransitionCheckResult | null`.

Implementation structure:
- Return `null` for unrecognized phases (anything not in the `CheckablePhase` union — including `"brainstorm"` and `"architect"`).
- For each checkable phase, read the relevant file(s) from disk using `existsSync` and `readFileSync` from `node:fs`, with paths constructed via `join(cwd, ...)`:
  - `test-write`: read `docs/plans/<topic>.md`, check it contains a line matching `## Tests`. Pass if found, fail if file missing or section absent.
  - `test-review`: check `docs/reviews/<topic>-tests.md` exists. Pass if present, fail if absent.
  - `impl-plan`: read `docs/plans/<topic>.md`, check it contains a line matching `## Steps`. Pass if found, fail if file missing or section absent.
  - `implement`: read `docs/plans/<topic>.md`, find the `## Steps` section, extract all `**Status:**` values, pass only if every status is exactly `done`. Fail if file missing, no Steps section, or any status is not `done`. Note: blocked statuses include trailing text (e.g., `blocked — waiting on dependency`), so match with a regex or trim — `**Status:** done` is the only passing value.
  - `review`: check `docs/reviews/<topic>.md` exists.
  - `handle-review`: check `docs/reviews/<topic>.md` exists.
  - `cleanup`: check that all three working artifacts are absent: `docs/plans/<topic>.md`, `docs/reviews/<topic>.md`, `docs/reviews/<topic>-tests.md`. Pass only if none exist.
- Every returned result must have a non-empty `detail` string describing what was checked and the outcome.

Import `existsSync` and `readFileSync` from `node:fs` and `join` from `node:path` at the top of the file.

**Verify:** `npx vitest run extensions/workflow/autoflow-checks.test.ts` — all tests pass.
**Status:** done

### Step 2: Guard `workflow_phase_complete` registration

In `extensions/workflow/index.ts`, wrap the `pi.registerTool({ name: "workflow_phase_complete", ... })` call (the entire block from the `pi.registerTool({` line through its closing `});`) inside `if (!process.env.PI_PARENT_LINK) { ... }`. This prevents the tool from registering in subagent processes, where `PI_PARENT_LINK` is set by the subagents extension.

Move the `STOP_TEXT` constant declaration inside the guard as well, since it's only used by the tool.

No test for this — it's a one-line conditional guard on existing code, and the behavior (tool not available in subagents) is an environmental concern that can't be unit tested without mocking pi's extension API.

**Verify:** `grep -n "PI_PARENT_LINK" extensions/workflow/index.ts` shows the guard wrapping the tool registration. Visually confirm the `pi.registerTool` call is inside the `if` block.
**Status:** done

### Step 3: Create the autoflow skill

Create `skills/autoflow/SKILL.md` — the orchestration skill that drives the autonomous pipeline. This is the main deliverable: a Markdown skill file with YAML frontmatter (`name: autoflow`, description) and a structured body.

The skill must cover:

**Frontmatter:**
```yaml
name: autoflow
description: "Run the full development workflow pipeline with minimal human intervention. Brainstorm and architect are interactive; remaining phases run autonomously via subagents."
```

**Interactive phases (brainstorm, architect):**
- Instruct the primary agent to run these directly, following the brainstorming and architecting skills in conversation with the user.
- After brainstorm: commit the artifact, then proceed to architect.
- After architect: commit the artifact, then evaluate skip decisions before proceeding.

**Skip decisions (after architect completes):**
- Evaluate scope: for small, straightforward changes, skip to impl-plan (bypass test-write and test-review). For very small changes, skip to implement (bypass test-write, test-review, and impl-plan).
- When skipping, write scaffold sections to the plan file using the format from `extensions/workflow/index.ts` (the `SKIPPED_TESTS` and `SKIPPED_STEPS` constants — reproduce their content in the skill's instructions). Commit before proceeding.
- If uncertain whether to skip, ask the user.

**Autonomous phase orchestration (test-write through cleanup):**
- For each remaining phase, spawn a single subagent using the `subagent` tool. Each subagent gets a task string containing:
  1. The skill to read and follow (e.g., `skills/test-writing/SKILL.md`)
  2. The topic slug
  3. The working directory context
  4. The clarification invariant: "If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase."
- After spawning, call `await_agents` to wait for completion.
- If an `<agent_message>` interrupt arrives with `response_expected="true"`, the primary either answers directly or relays to the user, then calls `respond` and resumes `await_agents`.

**Transition validation (after each subagent completes):**
- Call `checkTransitionArtifact(phase, topic, cwd)` from `extensions/workflow/autoflow-checks.ts` using the `bash` tool (e.g., a one-liner Node script, or by reading the artifact files directly and checking manually). Actually — the primary agent can't import TypeScript. Instead, instruct the primary to validate artifacts directly: read the expected file and check for the expected content, following the artifact check table from the architecture.
- If validation passes, proceed to the next phase.
- If validation fails (artifact missing or incomplete), retry with one fresh subagent. If the retry also fails, escalate to the user.

**Handle-review special case:**
- After handle-review completes, read `docs/reviews/<topic>.md` and evaluate: if the review contained structural findings or multiple major/critical findings, spawn a re-review (delete the review file, commit, then spawn a `review` subagent). Otherwise proceed to cleanup.

**Escalation:**
- The primary can always surface questions or problems to the user.
- Default posture: proceed autonomously, escalate when uncertain.

**Phase sequence reference** (for the skill to enumerate):
```
test-write → test-review → impl-plan → implement → review → handle-review → cleanup
```

The skill should be structured with clear sections for each concern (interactive phases, skip decisions, autonomous orchestration, transition validation, escalation). Use the same Markdown heading hierarchy as other skills in the repo.

**Verify:** `cat skills/autoflow/SKILL.md` shows the complete skill file with frontmatter, all sections described above, and no references to `workflow_phase_complete`.
**Status:** not started
