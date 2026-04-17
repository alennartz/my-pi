# DR-030: Bundle skill-owned logic as scripts alongside `SKILL.md`

## Status
Accepted

## Context
Transition validation for `/autoflow` needed somewhere to live. The existing implementation (`extensions/workflow/autoflow-checks.ts`) was a pi extension whose only consumer was the autoflow skill, and the skill had independently grown a parallel bash-snippet version of the same predicates. The two had already diverged on the `implement` check: the TS module scoped `**Status:**` lookups to the `## Steps` section, while the bash example in `SKILL.md` (`grep -oP '(?<=\*\*Status:\*\* ).+' plan.md`) scanned the whole file — so a `**Status:**` line anywhere else would confuse the bash path but not the TS path. This is the exact divergence DR-026 had flagged as a maintenance risk. With `/workflow` being removed, the extension had no other consumer and no reason to continue existing as an extension.

## Decision
Move the logic to `skills/autoflow/check-transition.ts`, bundled next to `SKILL.md`, invoked from the orchestrator via `bash` as `npx tsx skills/autoflow/check-transition.ts <phase> <topic>`. Skills can own executable scripts (precedent: `agent-browser` bundles `.sh` templates); the extension layer is reserved for code that actually needs pi's runtime (tool registration, event hooks, command handlers).

Rejected alternatives:
- **Keep it as a pi extension.** No runtime integration was needed, so the extension layer added no value and fragmented the skill's implementation across two directories (`extensions/workflow/` and `skills/autoflow/`) with no coupling reason.
- **Inline as bash one-liners in `SKILL.md`.** What already existed, and what produced the `implement`-check divergence in the first place. TS with a CLI wrapper is the minimum viable single-source-of-truth — expressive enough to scope predicates correctly, testable under vitest, and still callable from the orchestrator's `bash` tool.

## Consequences
- Re-converges the previously-parallel bash + TS implementations, eliminating DR-026's flagged divergence risk. The 28 behavioral tests move with the logic to `skills/autoflow/check-transition.test.ts`.
- Precedent for future cases: when a skill needs non-trivial executable logic and doesn't require pi runtime integration (tool registration, event hooks, commands), preferring a bundled script over a dedicated extension is now an option on the table. Not a blanket rule — validated on this case only.
- Adds `tsx` as a devDep and a small indirection (`npx tsx`) at orchestrator time.
- Script must be invoked from the repo root — paths resolve against `process.cwd()`. Documented constraint in `SKILL.md`; dismissed as a nit in review since the orchestrator always runs from the repo root in practice.
