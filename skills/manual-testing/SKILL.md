---
name: manual-testing
description: "Exercise shipped functionality the way a human would — run a persistent smoke suite of primary user journeys, add topic-specific tests, fix straightforward issues inline, and grow the manual-test tooling over time. Use after handle-review and before cleanup to close the outer loop. Requires a plan in docs/plans/<topic>.md — if it doesn't exist, run the earlier pipeline phases first."
---

# Manual Testing

## Overview

Close the outer loop. Automated tests check component contracts; this skill exercises the thing that was built the way its user will — clicking the UI, invoking the CLI, hitting the endpoint, running the flow end-to-end — and fixes what breaks.

The skill is **generic**: it runs in whatever repo autoflow runs in. The "app under test" is whatever this repo produces (web app, CLI, service, library, extension, …). The skill is **incremental**: it maintains a persistent manual test plan and tool collection in the repo, so each run benefits from prior runs and primary user journeys become cheap to smoke-test.

This skill is autonomous. When a manual test fails and the fix is obvious and aligned with the architecture, it fixes and re-runs. It only escalates when a failure reveals an architectural flaw, requires a disproportionately complex fix, or is otherwise ambiguous.

## Invocation

This skill is invoked inside a subagent spawned by the autoflow orchestrator. The spawn message loads this skill for a given topic and may include optional focus hints. Expected task-string shape:

```
Read and follow the skill at `skills/manual-testing/SKILL.md` for topic `<topic>`.

Working directory: <cwd>

Focus hints (optional): <free-form guidance from orchestrator or user>

If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase.
```

## Conventions This Skill Establishes

- **`tools/manual-test/`** at the repo root — its own module, owned by this skill. Contains:
  - **`PLAN.md`** — the persistent, repo-wide manual test plan. Lists primary user journeys (the high-value happy paths a human would exercise). Each journey: what it is, why it matters, and which tool drives it. Lives indefinitely. Updated as the product evolves.
  - **`README.md`** — index of available tools: purpose, invocation, inputs/outputs, prerequisites.
  - **Tools themselves** — bespoke, reusable, parameterized. No one-shot scripts hard-coded to a single topic.
- **Per-topic artifact at `docs/manual-tests/<topic>.md`** — thin. Records what this run did; the bulk of "what to test" lives in `PLAN.md`, not here.
- **This skill does not edit `codemap.md`.** Cleanup handles the codemap refresh and uses this skill's artifact as input.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. If it doesn't exist, proceed without it.
2. **Read `docs/plans/<topic>.md`** — the plan (architecture + steps). If it doesn't exist, tell the user and stop.
3. **Read `docs/brainstorms/<topic>.md`** if it exists — original intent and user-facing scenarios.
4. **Read `docs/reviews/<topic>.md`** and `docs/reviews/<topic>-tests.md` if they exist — findings that shape what to test or deliberately avoid.
5. **Read `tools/manual-test/PLAN.md` and `tools/manual-test/README.md`** if they exist. Everything you need to know about this repo's primary user journeys and existing tooling is there.
6. **Identify what this repo produces** and how a human exercises it (browser, CLI, HTTP client, VS Code host, …). If genuinely unclear, ask the parent agent.

### 1. Bootstrap on First Run (one-time)

If `tools/manual-test/PLAN.md` does not exist, you're establishing the persistent plan this run. Before going further:

1. Figure out the repo's primary user journeys — the high-value happy paths that, if broken, would represent an unacceptable regression. Derive them from the codemap, existing user-facing docs (READMEs), and the brainstorm/plan for this topic. Keep the list focused; "primary" is the operative word.
2. Write `tools/manual-test/PLAN.md` with a section per journey: what it is, why it matters, the tool that drives it (may be TBD for journeys whose tools you'll build this run).
3. Create `tools/manual-test/README.md` with an initial index (may be empty if no tools exist yet).
4. Commit: `chore: bootstrap manual-test plan and tooling`.

On subsequent runs `PLAN.md` already exists — skip bootstrap and use what's there.

### 2. Draft the Per-Topic Artifact

Create `docs/manual-tests/<topic>.md` **before** running anything:

```markdown
# Manual Testing — <topic>

## Smoke Suite

The subset of `tools/manual-test/PLAN.md` journeys exercised this run, and
why (all journeys by default; a subset only when scoped by focus hints).

## Topic-Specific Tests

Behaviors specific to this topic that aren't covered by the persistent plan.
For each: what it is, why it matters for this topic, and the tool used.
Items promoted into `PLAN.md` during this run (new primary journeys) are
noted here too.

## Tools

- Reused: <existing tools under tools/manual-test/ or existing skills>
- New: <new tools introduced in this run>
- Improved: <existing tools generalized or hardened this run>

## Results

For each item from Smoke Suite and Topic-Specific Tests: what was run, what
was observed, verdict — pass | fixed-inline | open. Fixed-inline entries
include a one- or two-sentence fix note for cleanup's DR consideration.

## Plan Updates

Journeys added to, modified in, or retired from `tools/manual-test/PLAN.md`
this run. Empty if the persistent plan was unchanged.

## Open Issues

Anything not fixed inline — escalations, ambiguous findings, user-decision
items. Empty if everything passed or was fixed.
```

Commit once drafted: `docs: manual-testing plan for <topic>`.

### 3. Prepare Tooling

For each journey in the Smoke Suite and each Topic-Specific Test:

1. **Prefer reuse.** Existing tools under `tools/manual-test/` first; existing agent skills (`agent-browser`, etc.) second.
2. **Prefer generalization over forking.** If a tool almost fits, extend or parameterize it. Record the improvement in the artifact's *Tools → Improved* list and update `tools/manual-test/README.md`.
3. **Build new only for genuine gaps.** New tools go under `tools/manual-test/<tool-name>/` (or a single file if trivial). Requirements:
   - Short README or top-of-file docstring: purpose, inputs, outputs.
   - Parameterized for reuse — no topic-specific hard-coding.
   - Registered in `tools/manual-test/README.md`.

### 4. Execute Tests

Run the Smoke Suite first, then Topic-Specific Tests. For each, record in *Results*:

- What was run (tool/skill, invocation).
- What was observed.
- Verdict: **pass**, **fixed-inline**, or **open**.

#### When a Test Fails

- **Fix inline** when the root cause is clear, the fix is consistent with the architecture in `docs/plans/<topic>.md`, and the fix is localized and low-complexity. Apply, commit (`fix: <short description> (manual-testing)`), re-run, mark `fixed-inline`.
- **Escalate** when the failure suggests a fundamental architectural flaw, would require a high-complexity fix, or is ambiguous. Log in *Open Issues* with observation, suspected cause, and why you're not fixing inline. Use `send(to='parent', expectResponse=true)` only if you need an answer to continue.

Keep iterating until every item is `pass`, `fixed-inline`, or logged in *Open Issues* with a clear reason.

### 5. Update the Persistent Plan

If this topic introduced, materially changed, or retired a primary user journey, update `tools/manual-test/PLAN.md` accordingly:

- **Added journey** — new high-value path this topic makes first-class.
- **Modified journey** — existing path whose shape changed.
- **Retired journey** — path no longer applicable.

Not every topic-specific test belongs in `PLAN.md`. Promote only genuine primary journeys — the plan stays focused. Record every change in the artifact's *Plan Updates* section.

### 6. Finalize

1. Verify *Tools* reflects reality and `tools/manual-test/README.md` lists every tool.
2. Verify *Results* has an entry for every item in Smoke Suite and Topic-Specific Tests.
3. Verify *Plan Updates* is populated or explicitly empty.
4. Verify *Open Issues* is populated or explicitly empty.
5. Commit: `docs: manual-testing results for <topic>` — artifact + `PLAN.md` updates + final README edits. Inline-fix commits from step 4 stay as their own commits.

## Key Principles

- **Persistent plan, cheap smoke.** The expensive part (enumerating journeys, building tools) is paid once. Every run amortizes it.
- **Primary journeys only in `PLAN.md`.** The plan's value is focus. Topic-specific edge cases live in the per-topic artifact, not the persistent plan.
- **Accumulate tooling, don't discard it.** Generalize instead of fork, document every tool, extend over replace.
- **Fix inline when obvious, escalate when structural.** The bar is architectural viability, complexity, or ambiguity — not ordinary bugs.
- **Upstream artifacts scope topic-specific tests.** Don't invent user behaviors beyond what brainstorm/plan/reviews imply. Focus hints narrow further.
- **Do not edit `codemap.md`.** Record what changed in the artifact; cleanup updates the codemap using that as input.
- **Artifact first, then execute.** Drafting before running forces deliberate scope and gives the orchestrator something to audit if the skill stalls.
