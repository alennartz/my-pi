# Review: remove-manual-workflow

**Plan:** `docs/plans/remove-manual-workflow.md`
**Diff range:** `HEAD..<working tree>` (plan was authored post-hoc; no pre-test-write / pre-implementation commit exists)
**Date:** 2026-04-17

## Summary

The plan is faithfully implemented across the diff: `extensions/workflow/` is deleted, the check module is relocated to `skills/autoflow/` with a CLI wrapper, the autoflow skill now invokes the bundled script, and README / codemap / onboard are updated consistently. All 121 tests pass, the script's exit-code contract behaves as documented, and a grep sweep confirms no residual references outside `docs/decisions/` (historical, intentional). No critical issues. A handful of nit-level concerns around the CLI wrapper are worth noting; none block landing.

Caveat on scope: because the plan was written from the diff rather than before it, the "plan adherence" pass is weaker than usual — it verifies internal consistency between plan and code but can't surface architect-phase concerns that never had a chance to be raised. The code correctness pass is unaffected.

## Findings

### 1. CLI resolves artifact paths against `process.cwd()` with no repo-root safeguard

- **Category:** code correctness
- **Severity:** warning
- **Location:** `skills/autoflow/check-transition.ts:143` (the `process.cwd()` argument passed into `checkTransitionArtifact`)
- **Status:** dismissed
- **Resolution:** The orchestrator always invokes the script from the repo root per the documented form in `skills/autoflow/SKILL.md` (`npx tsx skills/autoflow/check-transition.ts <phase> <topic>`). Self-locating via `import.meta.url` would be overengineering for a scenario that doesn't happen in practice.

`checkTransitionArtifact` joins `docs/plans/<topic>.md` onto the `cwd` argument. The CLI passes `process.cwd()`, and the SKILL.md instructs the orchestrator to run the script "from the repo root." There is no detection if the orchestrator happens to be in a subdirectory (e.g. after a `cd` in a prior bash call within the same shell — though pi's `bash` tool typically resets). If that invariant breaks, every phase check would silently fail with `Plan file does not exist: docs/plans/<topic>.md` and the orchestrator would read that as a real failure and relaunch the subagent. Consider either (a) self-locating via `import.meta.url` → walking upward to the nearest `package.json`, or (b) documenting in SKILL.md that the orchestrator should pass `cd <repo-root> && …` defensively. Low-probability but the failure mode is confusing when it does happen.

### 2. CLI conflates "phase has no check" with "unknown phase name"

- **Category:** code correctness
- **Severity:** nit
- **Location:** `skills/autoflow/check-transition.ts:157-161`
- **Status:** dismissed
- **Resolution:** Defensive-only today — the orchestrator never sends `brainstorm`/`architect` per SKILL.md's phase sequence. Splitting exit codes would add contract surface for no behavioral benefit.

When `checkTransitionArtifact` returns `null` the CLI prints `No transition check defined for phase: <phase>` and exits 2 — the same code path handles `brainstorm`, `architect`, and a typo like `implemet`. The orchestrator shouldn't be passing `brainstorm`/`architect` in practice (SKILL.md routes only autonomous phases through the script), so this is defensive-only. But if it ever does, exit 2 is documented as "usage error" and the orchestrator cannot distinguish "valid phase, no check needed — proceed" from "typo — stop and escalate." Splitting into two exit codes (e.g. 3 for "phase has no check, skipping") would make the contract tighter. Noted as a nit because the current shape hasn't caused a real problem.

### 3. `invokedAsScript` guard is filename-suffix based

- **Category:** code correctness
- **Severity:** nit
- **Location:** `skills/autoflow/check-transition.ts:134-135`
- **Status:** resolved
- **Resolution:** Replaced the filename-suffix regex with the canonical ESM idiom: `import.meta.url === pathToFileURL(process.argv[1]).href`. Tests still pass (121/121).

The main-guard uses `/check-transition\.ts$/.test(process.argv[1])`. Any future script elsewhere named `check-transition.ts` that imports this module would inadvertently trigger CLI execution on import. The canonical Node-ESM idiom is `import.meta.url === pathToFileURL(process.argv[1]).href`. Harmless today (only one file has this name), but the regex-on-basename pattern is slightly brittle.

### 4. Shebang advertises a second entry point that SKILL.md doesn't document

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `skills/autoflow/check-transition.ts:1` (shebang) and file mode `755`
- **Status:** resolved
- **Resolution:** Dropped the shebang and removed the executable bit (`chmod -x`). The sole entry point is now the documented `npx tsx skills/autoflow/check-transition.ts …` form.

The file has `#!/usr/bin/env -S npx tsx` and is executable, which allows `./skills/autoflow/check-transition.ts <phase> <topic>` as an alternative to the documented `npx tsx skills/autoflow/check-transition.ts …`. The plan (step 2) and SKILL.md only describe the `npx tsx …` form. Not wrong — just an undocumented second entry point. Either document it or drop the shebang + exec bit for consistency.

## No Issues

- **Plan adherence (substantive):** Every step in the plan is reflected in the diff. The ported predicate logic in `skills/autoflow/check-transition.ts` is semantically identical to the HEAD version of `extensions/workflow/autoflow-checks.ts` (verified line-by-line). Test file was relocated with only the import path changed. `vitest.config.ts` now picks up `skills/**/*.test.ts`. `tsx@^4.21.0` is in `devDependencies`. `extensions/workflow/` is fully removed. `extensions/numbered-select/` and `lib/components/numbered-select.ts` are preserved and promoted to their own codemap module. No residual `/workflow`, `workflow_phase_complete`, `internal-workflow-next`, `extensions/workflow`, or `autoflow-checks` references outside `docs/decisions/`.
- **Test immutability:** N/A — no separate pre-test-write and pre-implementation commits exist (plan written post-hoc, so this phase-boundary invariant couldn't be checked).
- **Code correctness (beyond the four nits above):** No unhandled error paths, logic errors, race conditions, resource leaks, or security issues identified. The ported predicates have 28 dedicated behavioral tests and all pass. Script smoke-tested manually: unknown phase → exit 2, happy cleanup → exit 0, brainstorm → exit 2 (see finding #2). `npx vitest run` → 121/121.
