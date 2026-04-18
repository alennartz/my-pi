---
name: manual-testing
description: "Exercise shipped functionality the way a human would — drive the real artifact end-to-end, fix straightforward issues inline, accumulate reusable testing tools in the repo. Use after handle-review and before cleanup to close the outer loop. Requires a plan in docs/plans/<topic>.md — if it doesn't exist, run the earlier pipeline phases first."
---

# Manual Testing

## Overview

Close the outer loop. Automated tests check component contracts; this skill exercises the thing that was built the way its user will — clicking the UI, invoking the CLI, hitting the endpoint, running the flow end-to-end — and fixes what breaks.

The skill is **generic**: it runs in whatever repo autoflow runs in. The "app under test" is whatever this repo produces (web app, CLI, service, library, extension, …). The skill figures out what human-observable behavior to exercise by reading the upstream artifacts and the code, then drives it using whatever tools are available — existing agent skills (e.g. `agent-browser`), system utilities, and **bespoke tools that live in the repo and accumulate over time**.

This skill is autonomous. When a manual test fails and the fix is obvious and aligned with the architecture, it fixes and re-runs. It only escalates when a failure reveals an architectural flaw, requires a disproportionately complex fix, or is otherwise ambiguous.

## Invocation

This skill is invoked inside a subagent spawned by the autoflow orchestrator. The spawn message loads this skill for a given topic and may include optional focus hints (e.g. "pay special attention to the new upload flow", "skip the admin area — unchanged"). Expected task-string shape:

```
Read and follow the skill at `skills/manual-testing/SKILL.md` for topic `<topic>`.

Working directory: <cwd>

Focus hints (optional): <free-form guidance from orchestrator or user>

If you need clarification or encounter ambiguity, use `send(to='parent', expectResponse=true)` to ask. Do not stop or complete without finishing the phase.
```

## Conventions This Skill Establishes

- **Bespoke manual-test tooling lives at `tools/manual-test/`** at the repo root.
  - It MUST contain a `README.md` index that lists every tool, what it's for, how to invoke it, and any prerequisites.
  - Tools are designed for reuse across topics — clear CLI/API surface, documented inputs and outputs, no one-shot scripts hard-coded to a single test run.
  - `tools/manual-test/` is its own module in the codemap. This skill does not edit `codemap.md` — the cleanup phase handles that, using the artifact this skill produces as input.
- **Artifact lives at `docs/manual-tests/<topic>.md`.** Written incrementally throughout the skill's run. Structure below.
- **Upstream artifacts drive scope.** `docs/brainstorms/<topic>.md`, `docs/plans/<topic>.md` (both architecture and steps sections), `docs/reviews/<topic>.md`, and `docs/reviews/<topic>-tests.md` (any that exist) describe what was intended and what shipped. The manual tests exercise the user-facing behavior those artifacts describe.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. If it doesn't exist, proceed without it.
2. **Read `docs/plans/<topic>.md`** — the plan. You need the architecture section (what was meant to be built) and the steps section (what actually shipped). If the plan doesn't exist, tell the user and stop.
3. **Read `docs/brainstorms/<topic>.md`** if it exists — the original intent, especially any user-facing scenarios.
4. **Read `docs/reviews/<topic>.md`** and `docs/reviews/<topic>-tests.md` if they exist — open issues or limitations called out in review may shape what to test or deliberately avoid.
5. **Read `tools/manual-test/README.md`** if it exists. Learn what's already available before thinking about new tools. If the directory doesn't exist, you're establishing it this run.
6. **Identify what this repo produces** and how a human exercises it (web app → browser, CLI → shell invocation, HTTP service → request client, library with a demo app → demo app, VS Code extension → VS Code host, etc.). If it's genuinely unclear how a human would exercise the artifact, ask the parent agent.

### 1. Draft the Test Plan

Create `docs/manual-tests/<topic>.md` with a *Test Plan* section **before** running anything. List the user-facing behaviors to exercise — derived from the brainstorm/plan/reviews and the focus hints — and for each, the tool that will drive it. Prefer existing tools in `tools/manual-test/` and existing agent-level skills; only plan new tooling where there's a real gap.

Suggested sections (fill in incrementally, commit at the end):

```markdown
# Manual Testing — <topic>

## Test Plan

For each user-facing behavior: what it is, why it matters for this topic, and
the tool/skill used to drive it.

## Tools

- Reused: <existing tools under tools/manual-test/ or existing skills>
- New: <new tools introduced in this run, with one-line purpose>
- Improved: <existing tools that were generalized or hardened during this run>

## Results

For each item in the Test Plan: what was run, what was observed, and the
verdict — pass | fixed-inline | open.

For fixed-inline entries, note the fix in one or two sentences so cleanup can
consider whether it warrants a decision record.

## Open Issues

Anything not fixed inline — escalations, ambiguous findings, or issues the
user must decide on. Empty if everything passed or was fixed.
```

Commit the initial artifact once the Test Plan is drafted: `docs: manual-testing test plan for <topic>`.

### 2. Prepare Tooling

For each planned behavior:

1. **Prefer reuse.** If an existing tool under `tools/manual-test/` covers it, use it directly.
2. **Prefer generalization over forking.** If a tool almost fits, extend/parameterize it rather than copying it to a near-duplicate. Record the improvement in the artifact's *Tools → Improved* list and update `tools/manual-test/README.md`.
3. **Build new only for genuine gaps.** New tools go under `tools/manual-test/<tool-name>/` (or a single file if trivial). They must:
   - Have a short README or top-of-file docstring explaining purpose, inputs, outputs.
   - Be parameterized for reuse on future topics — no hard-coded topic-specific values.
   - Be registered in `tools/manual-test/README.md`.
4. **Agent-level skills count.** If `agent-browser`, `brave-search`, or similar existing skills already cover a behavior (e.g. driving a web UI), use them directly — don't re-build what's already available outside the repo.

### 3. Execute Tests

Run each planned behavior. For each, record in *Results*:

- What was run (tool/skill, invocation).
- What was observed.
- Verdict: **pass**, **fixed-inline**, or **open**.

#### When a Test Fails

Decide between **fix inline** and **escalate** using this rule:

- **Fix inline** when:
  - The root cause is clear from the code and the failure.
  - The fix is consistent with the architecture in `docs/plans/<topic>.md` (and, if present, the brainstorm).
  - The fix is localized and low-complexity — the kind of surgical change handle-review would also make autonomously.

  Apply the fix, commit it (`fix: <short description> (manual-testing)`), re-run the failing test, and on success record it as `fixed-inline` in *Results*.

- **Escalate** (record in *Open Issues* and stop running fixes for this behavior) when any of:
  - The failure suggests a **fundamental architectural flaw** — the design itself doesn't support the user behavior, or makes it extremely brittle.
  - A viable fix would be **high complexity** or touch many modules — it wants its own planning cycle, not an inline patch.
  - Root cause or fix is **ambiguous** — more than one reasonable interpretation, or you'd be guessing.

  For escalations, write what was observed, the suspected cause, and why you're not fixing it inline. Use `send(to='parent', expectResponse=true)` only if you need an answer to proceed; otherwise just log the issue and continue with other tests.

#### Looping

Keep iterating until either:
- Every planned behavior is `pass` or `fixed-inline`, **or**
- Remaining failures are all in *Open Issues* with a clear reason.

Do not invent additional tests beyond the Test Plan to pad coverage — expand the plan deliberately if new user-facing behavior surfaces, and note the addition in the artifact.

### 4. Finalize

1. Make sure *Tools* lists every tool reused, added, or improved, and that `tools/manual-test/README.md` reflects reality.
2. Make sure *Results* has an entry for every item in the Test Plan.
3. Make sure *Open Issues* is either populated or explicitly empty (e.g. "None — all planned behaviors passed or were fixed inline.").
4. Commit: `docs: manual-testing results for <topic>` — include the artifact and any final tool/readme updates. Inline-fix commits from step 3 stay as their own commits.

## Key Principles

- **Test the thing, not the tests.** Automated tests already covered contracts in the test-write phase. This phase exercises the artifact as a user would.
- **Accumulate tooling, don't discard it.** Tools under `tools/manual-test/` are a long-lived asset. Every run leaves that module stronger — generalize instead of fork, document every tool, and prefer extending over replacing.
- **Fix inline when obvious, escalate when structural.** The escalation bar is architectural viability, complexity, or genuine ambiguity — not ordinary bugs.
- **Upstream artifacts are the source of truth for scope.** Don't invent user behaviors that aren't implied by brainstorm/plan/reviews. Focus hints from the orchestrator narrow further.
- **Do not edit `codemap.md`.** Record what's new in the artifact; cleanup will update the codemap using that as input.
- **Artifact first, then execute.** Writing the Test Plan before running tests forces deliberate scope and gives the orchestrator something to audit if the skill stalls.
- **Prefer existing skills and tools.** `agent-browser` and similar general-purpose skills cover a lot of ground — reach for them before building bespoke tooling.
