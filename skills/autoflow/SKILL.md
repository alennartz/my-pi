---
name: autoflow
description: "Run the full development workflow pipeline with minimal human intervention. Brainstorm and architect are interactive; remaining phases run autonomously via subagents."
---

# Autoflow

## Overview

Drive the full development workflow pipeline — brainstorm through cleanup — with minimal human intervention. The first two phases (brainstorm, architect) are interactive: you run them directly in conversation with the user. All subsequent phases run autonomously via subagents, with the primary agent orchestrating transitions, validating artifacts, and escalating only when necessary.

Invoke with `/autoflow <description of what you want to build or change>`.

## Interactive Phases

### Brainstorm

1. Read and follow the `brainstorming` skill (`skills/brainstorming/SKILL.md`) for the topic.
2. When the brainstorm is complete, commit the artifact (`docs/brainstorms/<topic>.md`).
3. Proceed to architect.

### Architect

1. Read and follow the `architecting` skill (`skills/architecting/SKILL.md`) for the topic.
2. When the architecture is complete, commit the artifact (`docs/plans/<topic>.md`).
3. Before proceeding, evaluate skip decisions (see below).

## Skip Decisions

After architect completes, evaluate the scope of the change to decide which phases to run:

- **Full pipeline** — default. Proceed to test-write.
- **Skip to impl-plan** — for small, straightforward changes where upfront tests add little value. Bypasses test-write and test-review.
- **Skip to implement** — for very small changes (a few lines, a single file, a config tweak). Bypasses test-write, test-review, and impl-plan.

**If uncertain whether to skip, ask the user.**

When skipping, write scaffold sections to the plan file before spawning the target phase's subagent. Append the following to `docs/plans/<topic>.md`:

When skipping test-write/test-review (skip to impl-plan):

```markdown
## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.
```

When also skipping impl-plan (skip to implement), additionally append:

```markdown
## Steps

> **Skipped.** Work through the architecture methodically — identify affected files,
> make changes in a logical order, and commit in coherent units.
```

Commit the scaffolded plan before spawning the target phase's subagent.

## Autonomous Phase Orchestration

After the interactive phases and any skip scaffolding, execute the remaining phases sequentially. The phase sequence is:

```
test-write → test-review → impl-plan → implement → review → handle-review → cleanup
```

Start from whichever phase the skip decision targets (or test-write for the full pipeline).

### Spawning Phase Subagents

For each phase, spawn a single subagent using the `subagent` tool. The task string must contain:

1. **Skill reference** — which skill file to read and follow.
2. **Topic** — the filename slug.
3. **Working directory** — the repo root.
4. **Clarification invariant** — the following exact text:

> If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase.

**Task string template:**

```
Read and follow the skill at `skills/<skill-name>/SKILL.md` for topic `<topic>`.

Working directory: <cwd>

If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase.
```

The skill-to-phase mapping:

| Phase | Skill file |
|-------|-----------|
| test-write | `skills/test-writing/SKILL.md` |
| test-review | `skills/test-review/SKILL.md` |
| impl-plan | `skills/impl-planning/SKILL.md` |
| implement | `skills/implementing/SKILL.md` |
| review | `skills/code-review/SKILL.md` |
| handle-review | `skills/handle-review/SKILL.md` |
| cleanup | `skills/cleanup/SKILL.md` |

### Waiting and Handling Interrupts

After spawning a subagent, call `await_agents` to wait for completion.

If an `<agent_message>` interrupt arrives with `response_expected="true"`:
1. Read the subagent's question.
2. If you can answer it from your context (plan, architecture, brainstorm), respond directly using `respond`.
3. If you can't answer it — the question requires user judgment — relay it to the user, get their answer, then call `respond`.
4. After responding, call `await_agents` again to resume waiting.

### Transition Validation

After each subagent completes, validate the expected artifact before proceeding to the next phase:

| Phase | Validation |
|-------|-----------|
| test-write | `docs/plans/<topic>.md` contains a `## Tests` section |
| test-review | `docs/reviews/<topic>-tests.md` exists |
| impl-plan | `docs/plans/<topic>.md` contains a `## Steps` section |
| implement | `docs/plans/<topic>.md` — all `**Status:**` fields are `done` |
| review | `docs/reviews/<topic>.md` exists |
| handle-review | `docs/reviews/<topic>.md` exists |
| cleanup | `docs/plans/<topic>.md`, `docs/reviews/<topic>.md`, and `docs/reviews/<topic>-tests.md` are all absent |

**To validate:** use the `bash` tool to check file existence and content. For example:
- `test -f docs/reviews/<topic>.md && echo "exists" || echo "missing"`
- `grep -c "^## Tests$" docs/plans/<topic>.md` (returns count > 0 if section present)
- `grep -oP '(?<=\*\*Status:\*\* ).+' docs/plans/<topic>.md` to extract all status values

**If validation passes:** proceed to the next phase.

**If validation fails:** retry with one fresh subagent (same task string). If the retry also fails, escalate to the user with a summary of what the subagent produced and what's missing.

### Handle-Review Special Case

After handle-review completes and passes validation, read `docs/reviews/<topic>.md` and evaluate the review content:

- If the review contained **structural findings** (wrong module boundaries, missing interfaces, architectural violations) or **multiple major/critical findings**, trigger a re-review cycle:
  1. Delete `docs/reviews/<topic>.md`.
  2. Commit the deletion.
  3. Spawn a new `review` subagent (code-review skill).
  4. After that completes, spawn a new `handle-review` subagent.
  5. Repeat this evaluation.

- Otherwise, proceed to cleanup.

## Escalation

The default posture is **proceed autonomously, escalate when uncertain**.

Escalate to the user when:
- A subagent fails twice on the same phase.
- A subagent asks a question you can't answer from the existing artifacts.
- You're uncertain about a skip decision.
- Something unexpected happens that isn't covered by these instructions.

The user can always intervene — they see the subagent activity in real time.

## Key Principles

- **Brainstorm and architect are always interactive.** Don't automate the creative and decision-making phases.
- **One subagent per phase, sequential.** No parallelism across phases — each phase depends on the previous one's artifact.
- **The plan is the source of truth.** Subagents read the plan themselves; don't duplicate plan content in task strings.
- **Retry once, then escalate.** Don't loop on failures.
- **Don't call `workflow_phase_complete`.** That tool is for the interactive workflow. In autoflow, transitions are managed by this skill's orchestration logic.
