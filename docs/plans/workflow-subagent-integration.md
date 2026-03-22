# Plan: Workflow–Subagent Integration

## Context

Workflow skills currently assume the primary agent does all work itself — reading files, writing code, running reviews. Long implementations exhaust context, and phases with independent work run sequentially when they could parallelize. We're embedding subagent orchestration hints directly in skill prose so the primary naturally delegates. See `docs/brainstorms/workflow-subagent-integration.md`.

## Architecture

### Impacted Modules

**Skills** — five skill files edited, no new modules or extension changes needed. The subagent infrastructure (channels, fan-out, scout agent, orchestrating-agents skill) already supports everything.

- `skills/implementing/SKILL.md` — heavy rewrite of the execution model. Primary becomes a phase-level orchestrator that spawns module-aligned worker agents with inter-agent channels. Workers execute steps and communicate to unblock dependencies (not serialized). Workers message the parent as steps complete so the primary can mark them off in the plan in real-time. Commits happen when the group goes idle, giving the primary a checkpoint to review and decide the next phase. On larger plans, the primary slices work into phases — not for dependency management (channels handle that) but for the primary's own control: review, commit, course-correct, engage the user if needed. Workers do not edit the plan file or commit.

- `skills/planning/SKILL.md` — two changes: (1) swap investigation-phase language from read/explore verbs to "scout" verbs, and (2) remove the "pure linear order — no parallel annotations, no dependency graphs" constraint. Everything else stays — steps are still numbered, still have status and verify fields.

- `skills/code-review/SKILL.md` — add hint to run plan adherence and code correctness passes as two parallel subagents on the same diff. Both receive the plan and diff as input, neither needs the other's output. Clean fan-out, no channels. Primary merges findings into the final review document following the existing artifact format.

- `skills/cleanup/SKILL.md` — restructure to spawn subagents for codemap refresh and documentation pass *before* starting DR extraction. Primary works on DRs (conversational, needs user) while subagents run in the background. When both are done, primary deletes artifacts and commits.

- `skills/architecting/SKILL.md` — swap investigation-phase language from read/explore verbs to "scout" verbs. Decision-making flow unchanged.

### Interfaces

No interface changes. Skills are prose documents consumed by the agent — no APIs, no contracts between modules. The subagent tool suite, scout agent definition, and orchestrating-agents skill are unchanged.

### DR Supersessions

- **DR-003** (Plan as Living Progress Tracker) — superseded because the "pure linear sequence" constraint no longer holds. The implementer now orchestrates module-aligned workers that execute concurrently, with dependencies resolved via inter-agent channels rather than step ordering. New decision: the plan remains the living progress tracker with status fields and resumability, but steps are no longer constrained to pure linear execution. The implementer decides how to batch and parallelize at runtime based on module boundaries and step dependencies. The planner still numbers steps sequentially (it's a natural authoring order) but this ordering is not a parallelism constraint.

## Steps

### Step 1: Add scout verbs to architecting skill's investigation phase

In `skills/architecting/SKILL.md`, section `### 1. Investigate`, replace the language about directly reading code with "scout" verb phrasing. The current text says:

> *"Read into those modules — entry points, interfaces, key files — to understand the current reality. Don't read everything; read enough to make informed decisions."*

Change to instruct the agent to **scout** the impacted modules rather than read into them directly. The primary sees "scout" and spawns a scout agent to do the heavy file-reading, then works from the scout's prose summary plus surgical reads of key references. Keep the rest of the investigation flow unchanged — identifying impacted modules from the codemap, sharing findings as you go.

**Verify:** The word "scout" appears as a verb in the investigation section. The rest of the architecting skill is unchanged — decision-making flow, DR handling, artifact format all untouched.
**Status:** not started

### Step 2: Add scout verbs to planning skill's investigation phase

In `skills/planning/SKILL.md`, section `### 1. Investigate`, replace the current language:

> *"Dive into the code that the architecture references — the impacted modules, the interfaces that will change, the files where work will happen. You need to see the actual code to write steps specific enough to act on."*

Change to scout-verb phrasing — instruct the agent to scout the impacted modules and work from the returned prose with file references, surgically reading only what's needed for specificity. Keep the misalignment-detection instruction ("watch for misalignment between the architecture and the codebase") intact.

**Verify:** The word "scout" appears as a verb in the investigation section. Misalignment detection language is preserved. The rest of the planning skill — step format, key principles, artifact format — is unchanged.
**Status:** not started

### Step 3: Remove "pure linear order" constraint from planning skill

In `skills/planning/SKILL.md`, two changes:

1. Under `### 2. Generate the Plan`, the format rules say: *"**Steps are numbered sequentially.** Pure linear order — no parallel annotations, no dependency graphs."* — remove the "pure linear order" language and the prohibition. Steps are still numbered sequentially as natural authoring order, but this is not a parallelism constraint.

2. Under `## Key Principles`, the bullet *"Get the order right — since steps are purely linear, the sequence is the dependency graph. A step should never reference something a later step creates."* — soften to reflect that ordering is guidance for natural build sequence, not a concurrency constraint. Keep the principle that earlier steps should lay foundations for later steps (good authoring practice), but drop the framing that sequence *is* the dependency graph.

**Verify:** No reference to "pure linear order" remains. Steps are still numbered. The format rules and key principles reflect that ordering is guidance, not a concurrency constraint.
**Status:** not started

### Step 4: Rewrite implementing skill as orchestrator model

The heavy rewrite. In `skills/implementing/SKILL.md`:

#### Trivial plan escape hatch

Before entering orchestrator mode, the primary evaluates the plan's scope. If the plan touches **≤ 5 files** and the estimated changes are **under ~300 lines**, the primary executes directly using the existing sequential model (read the step, do the work, verify, mark done, commit). No workers, no group spawning — the overhead isn't worth it. Above that threshold, the primary shifts into orchestrator mode.

This is a judgment-call heuristic described in prose, not a hard gate. The primary can see the plan and decide.

#### Orchestrator mode

**Frontmatter description** — update to reflect that the primary orchestrates workers for non-trivial plans and executes directly for small ones.

**Overview** — rewrite to describe the dual model. For trivial plans, one-shot sequential execution. For larger plans, the primary becomes a phase-level orchestrator: reads the plan, groups work by impacted module (architecture section + codemap), spawns module-aligned workers with inter-agent channels. Workers execute steps and communicate via channels to unblock dependencies. The primary owns plan status updates and commits, never reads source files or writes code directly.

**Section 0 (Read the Plan and Codemap)** — keep as-is.

**Section 0.5 (Stamp the Starting Commit)** — keep unchanged.

**New section between 0.5 and current 1: Assess plan scope** — the trivial-plan check. Estimate file count and change volume from the plan's steps. If it's under threshold, proceed with direct execution (section 1a). If it's above, proceed with orchestrated execution (section 1b).

**Section 1a (Direct Execution)** — the existing sequential execution model, preserved for trivial plans. Same flow: mark in-progress, do the work, verify, mark done, commit per step. Keep it concise since the current skill already describes this well — can largely be retained with a note that this path is for small plans.

**Section 1b (Orchestrated Execution)** — the new orchestration flow:
1. Primary groups pending steps by module alignment, identifies inter-step dependencies.
2. Primary spawns a collaborative team of module-aligned workers with channels reflecting dependencies. Each worker gets: its step(s), the relevant file references from the plan, and scope boundaries.
3. Workers execute steps: write code, verify, report completion to parent. Workers communicate laterally via channels to share interfaces/types that unblock peer dependencies.
4. Primary receives completion messages, updates plan status fields, marks steps done.
5. When `<group_idle>` fires, primary reviews the state, commits (code changes + plan updates), and decides the next phase.
6. On larger plans, the primary slices work into phases for its own control: review, commit, course-correct, engage the user if needed.

**Section 2 (Handling Reality vs. Plan)** — keep the rigidity hierarchy (architecture hard, step scope soft, details flexible). Add that in orchestrated mode, workers escalate architecture conflicts to the primary via `send`, and the primary escalates to the user.

**Key Principles** — update to reflect the dual model:
- Trivial plans: one-shot sequential, same as before
- Non-trivial plans: primary never reads source files or writes code
- Workers don't edit the plan file or commit
- Channels resolve dependencies; phases are for primary control
- Keep existing principles that still apply: architecture inviolable, verify early, resumable, best effort, don't expand scope, pure functions by default

**Verify:** The implementing skill describes both execution paths. The trivial-plan escape hatch has a clear threshold (~5 files, ~300 LOC). Orchestrator mode has primary spawning workers, never touching code. Workers communicate via channels. Plan status updates and commits are primary-only. The rigidity hierarchy is preserved.
**Status:** not started

### Step 5: Add parallel passes hint to code-review skill

In `skills/code-review/SKILL.md`, add orchestration guidance between section 0 (Gather Context) and section 1 (Plan Adherence Pass). The hint instructs the primary to run sections 1 and 2 as two parallel subagents on the same diff — a fan-out pattern with no inter-agent channels. Both agents receive the plan and diff as input. The primary merges their findings into the final review document following the existing artifact format in section 3.

Keep the existing pass descriptions (sections 1 and 2) as-is — they become the task briefs for each subagent. The key addition is the orchestration wrapper explaining that these two passes run concurrently and the primary merges results.

**Verify:** The code-review skill contains a clear hint that the two passes should be run as parallel subagents. The existing pass descriptions are preserved. The merge step is described. The artifact format is unchanged.
**Status:** not started

### Step 6: Restructure cleanup skill for background delegation

In `skills/cleanup/SKILL.md`, restructure the process so that:

1. Section 0 (Gather Context) stays as-is — the primary reads artifacts.
2. After gathering context, the primary spawns subagents for **codemap refresh** (current section 2) and **documentation pass** (current section 3) as a fan-out — no inter-agent channels needed.
3. The primary works on **DR extraction** (current section 1) while the subagents run in the background. DR extraction is conversational and needs user interaction, so it stays with the primary.
4. When both subagents complete (`<group_idle>`), the primary proceeds to artifact deletion (current section 4) and commit (current section 5).

Reorder and renumber sections to reflect the new flow: gather context → spawn background agents for codemap + docs → extract DRs → wait for background agents → delete artifacts → commit.

**Verify:** The cleanup skill describes spawning codemap and doc-pass agents before starting DR extraction. The fan-out pattern is clear. DR extraction remains with the primary. The final delete-and-commit waits for all background work to complete.
**Status:** not started

### Step 7: Commit all skill changes

Stage all modified skill files and commit with message: `plan: workflow-subagent-integration`

**Verify:** `git log --oneline -1` shows the commit message. `git diff HEAD` is clean.
**Status:** not started
