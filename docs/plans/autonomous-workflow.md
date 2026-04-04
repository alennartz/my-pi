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
| cleanup | `docs/decisions/` updated, working artifacts cleaned |

**Primary → Plan file (skip scaffolding)**: When skipping phases, the primary writes scaffold sections to `docs/plans/<topic>.md` using the established "Skipped" marker format:
- `## Architecture` with skip note (only when skipping from brainstorm — not applicable here since architect is always interactive)
- `## Tests` with skip note
- `## Steps` with skip note (only when skipping to implement)

Commits the scaffolded plan before spawning the target phase's subagent.

### DR Supersessions

None. The autonomous workflow coexists with the traditional workflow — no existing decisions are superseded. DR-008 (context boundaries) is preserved structurally via subagents rather than session switching, but the principle and the boundary locations are unchanged.
