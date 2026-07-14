---
name: autoflow
description: "Run the full development workflow pipeline with minimal human intervention. Brainstorm and architect are interactive; remaining phases run autonomously via subagents."
---

# Autoflow

## Invocation Contract (Strict)

When this skill is invoked (via `/autoflow ...`) or explicitly provided by the user as instructions, it is **mandatory**.

- Do **not** switch to direct implementation mode.
- Do **not** make ad-hoc code edits outside the defined phase flow.
- Start at the Brainstorm phase and proceed through this skill's workflow unless the user explicitly asks to bypass/exit autoflow.
- If there is any ambiguity about whether autoflow applies, ask the user before doing any non-autoflow work.

Before taking substantive actions, acknowledge you are running autoflow and state the current phase.

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

After architect completes, evaluate the scope of the change to decide which phases to run. The choice is *where to enter the pipeline* and *which optional phases to include* — the bullets below are the common cases, not the whole space of valid options.

- **Full pipeline** — for large or high-stakes changes: broad module impact, tricky behavioral contracts, security-sensitive surfaces. Proceed to test-write, then test-review.
- **Skip test-review** — Run test-write, then proceed directly to impl-plan. Test Review is mostly valuable for topics where a missed behavioral gap is expensive or where the intended behavior might be misunderstood by smaller models.
- **Skip to impl-plan** — for small, straightforward changes where upfront tests add little value. Bypasses test-write and test-review.
- **Skip to implement** — for very small changes (a few lines, a single file, a config tweak). Bypasses test-write, test-review, and impl-plan.

These are examples, not an exhaustive menu. A valid skip decision drops a **contiguous prefix** of the pre-implementation phases (test-write → test-review → impl-plan) and enters at a coherent point — every phase downstream of the entry point still runs, and no phase runs without the artifacts its predecessors produce. So "skip test-write but run test-review" is not a valid option (test-review has nothing to review), and neither is skipping impl-plan while keeping the test phases in a way that leaves implement without a plan. Within that constraint, use judgment: the four bullets are the points that come up most often, not the only points you may choose.

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

When skipping test-review only (test-write still runs): after test-write completes and passes validation, append `**Review status:** skipped — test-review bypassed by skip decision` to the end of the `## Tests` section in the plan, commit, and proceed to impl-plan.

## Autonomous Phase Orchestration

After the interactive phases and any skip scaffolding, execute the remaining phases sequentially. The phase sequence is:

```
test-write → test-review → impl-plan → implement → review → handle-review → manual-test → cleanup
```

Start from whichever phase the skip decision targets (or test-write for the full pipeline).

### Spawning Phase Subagents

For each phase, spawn a single subagent using the `subagent` tool. The task string must contain:

1. **Skill reference** — which skill file to read and follow.
2. **Topic** — the filename slug.
3. **Working directory** — the repo root.
4. **Clarification invariant** — the following exact text:

Additionally, set the subagent's `model` field to the phase's tier from the mapping table below. Tiers (`cheap`, `medium`, `smart`, `frontier`) resolve to concrete models via the machine's tier config. You may append a thinking-effort suffix to any model with `:<level>` (levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`), but tier names don't take suffixes — use a concrete model id if you need to specify thinking effort.

> If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase.

**Task string template:**

```
Read and follow the skill at `skills/<skill-name>/SKILL.md` for topic `<topic>`.

Working directory: <cwd>

If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase.
```

The skill-to-phase mapping:

| Phase | Skill file | Model tier |
|-------|-----------|------------|
| test-write | `skills/test-writing/SKILL.md` | `medium` |
| test-review | `skills/test-review/SKILL.md` | `smart` |
| impl-plan | `skills/impl-planning/SKILL.md` | `frontier` |
| implement | `skills/implementing/SKILL.md` | `medium` |
| review | `skills/code-review/SKILL.md` | `medium` |
| handle-review | `skills/handle-review/SKILL.md` | `medium` |
| manual-test | `skills/manual-testing/SKILL.md` | `medium` |
| cleanup | `skills/cleanup/SKILL.md` | `medium` |

Tier rationale: impl-plan gets `frontier` because plan quality multiplies through every downstream phase. Review runs on `medium` because it only orchestrates — its correctness pass spawns on `frontier` (see the code-review skill). Phases executing against explicit specs run on `medium`.

**Phase-specific task-string addenda.** Weaker tiers need the phase boundary spelled out, not inferred. For the **test-write** phase, append this to the task string:

> Do NOT write any implementation in this phase — no function bodies that compute a result, no parsing/splitting/branching logic, even "obvious" one-liners. Interface bodies are stubs that throw "not implemented." Before committing, run the Red Gate (skill step 2.5): every new test MUST fail. If any new test passes, you wrote implementation — remove it until the test is red. A green new test in this phase is a failed phase.

### Waiting and Handling Interrupts

After spawning a subagent, call `await_agents` to wait for completion.

If an `<agent_message>` interrupt arrives with `response_expected="true"`:
1. Read the subagent's question.
2. If you can answer it from your context (plan, architecture, brainstorm), respond directly using `respond`.
3. If you can't answer it — the question requires user judgment — relay it to the user, get their answer, then call `respond`.
4. After responding, call `await_agents` again to resume waiting.

### Transition Validation

After each subagent goes idle, validate the expected artifact before proceeding.

**To validate:** run the bundled check script via the `bash` tool, from the repo root:

```
npx tsx skills/autoflow/check-transition.ts <phase> <topic>
```

The script prints `PASS [<phase>] <detail>` or `FAIL [<phase>] <detail>` and exits 0 on pass, 1 on fail, 2 on usage error / unknown phase.

It covers these phases: `test-write`, `test-review`, `impl-plan`, `implement`, `review`, `handle-review`, `manual-test`, `cleanup`. (brainstorm and architect are interactive and have no check.) For the full predicate list, see `skills/autoflow/check-transition.ts`.

**If validation passes:** tear down the subagent and proceed to the next phase.

**If validation fails:** the subagent stopped before finishing. Its last output will be visible to you — read it to understand why it stopped early. Then use `send(to='<agent-id>')` to instruct it to continue working until the phase is complete, and call `await_agents` again. Do **not** tear down and relaunch — the subagent still holds its full context and is better positioned to resume than a fresh agent starting from scratch.

If the subagent repeatedly goes idle without passing validation (no progress between attempts), escalate to the user with a summary of what the subagent produced, what's missing, and why it appears stuck.

### Handle-Review Skip on Clean Review

After review passes validation, check the review file for open findings before spawning handle-review:

```
grep -c '\*\*Status:\*\* open' docs/reviews/<topic>.md
```

If there are zero open findings, skip handle-review entirely — there is nothing to resolve. Note the skip in your acknowledgment and proceed directly to the Manual-Test Skip Decision.

### Handle-Review Special Case

After handle-review completes and passes validation, read `docs/reviews/<topic>.md` and evaluate the review content:

- If the review contained **structural findings** (wrong module boundaries, missing interfaces, architectural violations) or **multiple major/critical findings**, trigger a re-review cycle:
  1. Delete `docs/reviews/<topic>.md`.
  2. Commit the deletion.
  3. **Resurrect the original review agent** (its `session_id` is in its teardown report) instead of spawning a fresh one. It already holds the plan context and its own findings with their reasoning — fix verification builds on that instead of rebuilding it. Task template:

     ```
     Fixes for your review findings landed in commits since your review (diff from
     the HEAD you reviewed to current HEAD). Re-review scoped to those fixes:
     verify each of your prior findings is resolved, and check the fix diff for
     newly introduced issues. Write a fresh docs/reviews/<topic>.md (the old one
     was deleted) and commit. Do not re-run the full-baseline review or the
     two-pass fan-out. Prefer resurrecting your pass subagents for the
     verification — their accumulated file context is mostly cache-priced
     (~10% of fresh tokens), far cheaper than re-reading files at full price.
     Only do the re-check directly when the fix diff is trivial enough that a
     couple of fresh reads settle it.
     ```

  4. After that completes and passes validation, **resurrect the original handle-review agent** the same way, with a task pointing at the fresh review file.
  5. Repeat this evaluation.

  If a resurrection fails (e.g., the session is unavailable), fall back to spawning a fresh subagent for that phase.

- Otherwise, evaluate the Manual-Test Skip Decision below.

### Manual-Test Skip Decision

After handle-review stabilizes, decide whether to run manual-test. Manual-testing maintains a persistent smoke suite at `tools/manual-test/PLAN.md` and reusable tools at `tools/manual-test/`, so the per-topic cost is usually small — the default is **run it, even for small changes**. A small change can still break a primary user journey; that's exactly what the smoke suite catches.

Skip only in these narrow cases:

- **Docs-only changes** — README, comments, decision records. Reading the diff is the test.
- **Cannot be exercised in-environment** — production-only paths, CI-only logic, code requiring services the agent can't reach. This is a capability gap, not an optimization — surface it to the user explicitly rather than silently skipping.

If uncertain, ask the user. When skipping, note the reason in your acknowledgment so it's visible in the transcript, and proceed directly to cleanup.

### Manual-Test Phase

When not skipped, spawn a `manual-test` subagent using the skill mapping above. The task string may include focus hints — areas of the change that warrant special scrutiny, or areas to deliberately skip (e.g. unchanged surfaces not touched by this topic).

If manual-testing escalates via `send(to='parent', expectResponse=true)`, relay the question to the user as with any other phase. If manual-testing finishes with *Open Issues* populated in `docs/manual-tests/<topic>.md`, surface that to the user before proceeding to cleanup — they may want to resolve the issues or loop back through earlier phases rather than close out.

## Escalation

The default posture is **proceed autonomously, escalate when uncertain**.

Escalate to the user when:
- A subagent repeatedly goes idle without making progress on the current phase.
- A subagent asks a question you can't answer from the existing artifacts.
- You're uncertain about a skip decision.
- Something unexpected happens that isn't covered by these instructions.

The user can always intervene — they see the subagent activity in real time.

## Key Principles

- **Brainstorm and architect are always interactive.** Don't automate the creative and decision-making phases.
- **One subagent per phase, sequential.** No parallelism across phases — each phase depends on the previous one's artifact.
- **The plan is the source of truth.** Subagents read the plan themselves; don't duplicate plan content in task strings.
- **Continue before retrying.** When a subagent stalls, send it a message to continue — don't discard its context by relaunching. Escalate if it can't make progress.
