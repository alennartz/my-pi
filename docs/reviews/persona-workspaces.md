# Review: Persona Workspaces

**Plan:** `docs/plans/persona-workspaces.md`
**Diff range:** `7304437c39a31c371c041d23d093f8a1fbdf6d0f..5374b5b` (baseline: `pre-test-write-commit`)
**Date:** 2026-10-07

## Summary

The plan was implemented faithfully: all eight steps land as specified, the architecture's core seams (wholesale single-active-file persona selection, body-as-preamble via `customPrompt`, spawned-payload carriage through the child-session registry, pin-beats-explicit model precedence, transcript-derived notice dedup) are implemented at the right boundaries, the five implementation-time rulings (a–e) are honored exactly, and test immutability is clean apart from the plan's own adjudicated exceptions. Both verification claims were reproduced (333/333 targeted, 804/804 full suite; `git diff --check` clean). No critical defects. The findings that matter are one piece of uncommitted-to-plan work riding an implementation commit (an unrelated `AGENTS.md` rewrite the Step 8 log claims doesn't exist) and two capability/trust issues on the restore and child-cwd paths of the construction gates, plus doctrine-level resolver duplication that has already begun to drift.

## Findings

### 1. Unrelated AGENTS.md rewrite rides the implementation commit

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `AGENTS.md:1-14` (committed in `9a7c185`); contradiction at `docs/plans/persona-workspaces.md:287`
- **Status:** dismissed
- **Resolution:** Concurrent user change (an `AGENTS.md` rewrite), intentional per the standing concurrent-changes rule and committed as-is — never to be reverted. The plan's Step 8 verification log is corrected to record the exception instead of claiming a strictly step-scoped diff; no history rewriting.

No plan step touches `AGENTS.md`; Step 7 scopes doc updates to `skills/orchestrating-agents/SKILL.md`, `skills/specialist-design/SKILL.md`, and `codemap.md`. The diff rewrites the vision statement and deletes five lookup-table rows (`docs/plans/`, `agents/*.md`, `skills/*/SKILL.md`, `docs/pi-internals/`, `docs/research/`, the global-rules pointer) — zero persona content. The Step 8 verification log asserts "diff reviewed — only step-scoped files plus this plan," so the mandated unrelated-changes review either missed or misreported this. It may be an intentional concurrent change (in which case it should not be riding a persona-workspaces commit under a misleading message), but as committed it strips navigation entries from the repo map with no traceability. Worth human confirmation.

### 2. Restore path fails open on skill-resolution errors — restored child silently gets all skills

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agent-set.ts:1174`, `extensions/subagents/agent-set.ts:1181-1196`
- **Status:** resolved
- **Resolution:** User ruling: resolvable-subset semantics on the restore path. A stale/typo'd list degrades narrow — unresolvable names are dropped and logged, the resolved remainder is the complete skill set (new `noSkills` spec/config flag distinguishes a declared set from no declaration), and an all-stale list yields zero skills instead of ordinary discovery. Never wider than the declared list; the shared `resolvePersonaSkillPaths` resolver (`agents.ts`) owns the policy.

`toRestoreSpec` resolves the active persona's declared skills via `resolveRestoredSkills`, which swallows resolution failures (`console.error`, return `undefined`), then falls back with `?? []`. An empty `skillPaths` is not "no skills" downstream — `managed-child-session.ts:395` only sets `noSkills: true` / `additionalSkillPaths` when `skillPaths.length > 0`, so `[]` means ordinary discovery: the child loads every discovered skill. Concrete failure: a workspace declares `skills: scout, reviw` (one typo). A fresh spawn (`session-owner.ts:1283-1288`) and a resurrect (`session-owner.ts:1537-1543`) both hard-fail with "Failed to resolve skills…", but the restore path (session restart / `startUnlocked` of survivors, `agent-set.ts:419`) silently restores the child with the full skill set instead of the intended two. That is capability widening on a construction gate the architecture explicitly treats as security-relevant, and it inverts the fresh-spawn semantics for the identical condition (fail closed → fail open).

### 3. Child-cwd model-tier overlay is gated on the parent's project trust

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/session-owner.ts:1273-1279`
- **Status:** resolved
- **Resolution:** Dissolved by removal (user philosophy: this security gating is not wanted): `loadTierConfig` dropped `projectTrusted` and reads the project overlay unconditionally — tier remapping is user configuration, not a trust boundary — and all call sites (including pre-existing ones) were updated. No foreign-cwd trust source is needed.

`spawnAgents` reads the tier config for the child's effective cwd: `this.loadTiers(effectiveCwd, ctx.isProjectTrusted())`. `ctx.isProjectTrusted()` is the trust state of the parent session's project, but `effectiveCwd` can be any directory the spawn request names (`resolveAgentCwds` validates only that it exists). When the parent's project is trusted and a child is spawned into a different, untrusted directory, that directory's `.pi/model-tiers.json` is honored anyway — an untrusted repo can remap `cheap`/`smart`/… to any model the user has configured, steering task content (possibly containing repo secrets) to a provider the user didn't intend and running up cost on expensive models. Pre-change, the overlay was read only from the parent cwd under the parent's trust flag (scope-consistent); the change extends the read to foreign cwds without re-scoping the trust decision (the child's own trust is resolved separately via `resolveChildProjectTrust` and never consulted here).

### 4. Model-reference resolution is implemented twice

- **Category:** code correctness (design doctrine — FUNCTIONS.md §6, each business operation lives in one function)
- **Severity:** warning
- **Location:** `extensions/subagents/session-owner.ts:181-257` vs `extensions/persona-workspaces/index.ts:378-406`
- **Status:** resolved
- **Resolution:** One resolver: `resolveDeclaredModelRef` in `extensions/subagents/model-tiers.ts` holds the mechanics once (tier detection, tier resolution, thinking-suffix split, id-or-`provider/id` matching, canonical re-serialization) with the failure semantics as a parameter (`throw`/`diagnostic`/`passthrough`); `resolveChildModelRef` and `bindDeclaredModel` are thin per-caller policy wrappers over it.

"Resolve a declared model reference (tier name or model id, optional `:<level>` suffix) against the tier config and available models" now lives in two independent implementations — `resolveChildModelRef` (spawn/fork construction) and `resolveDeclaredModel` (root front-matter binding) — each redoing tier-name check, `resolveModelRef`, `stripThinkingSuffix`, id-or-`provider/id` matching, and canonical re-serialization with the thinking suffix. The availability predicate alone exists three times (`isAvailableModelRef` at `session-owner.ts:181`, an inline `.find` at `session-owner.ts:235-237`, `findAvailableModel` at `persona-workspaces/index.ts:402`). The copies have already diverged in failure semantics (throw vs. UI diagnostic) — that divergence is legitimate per-caller policy and should be a parameter of one resolver, not two hand-maintained copies of the mechanics. A future fix to suffix handling or provider/id matching will land in one path and miss the other.

### 5. Active-file skill resolution is duplicated across three spawn paths with divergent error semantics

- **Category:** code correctness (design doctrine — FUNCTIONS.md §6)
- **Severity:** warning
- **Location:** `extensions/subagents/session-owner.ts:1283-1288` (spawnAgents), `extensions/subagents/session-owner.ts:1537-1543` (resurrectAgents), `extensions/subagents/agent-set.ts:1181-1196` (toRestoreSpec/`resolveRestoredSkills`)
- **Status:** resolved
- **Resolution:** One shared resolver, `resolvePersonaSkillPaths` next to `resolveSkillPaths` in `agents.ts`, with an explicit failure-policy parameter (`fatal` for spawn/fork/resurrect — unchanged fail-closed behavior; `subset` for restore per the finding-2 ruling). The intended semantics is now a single decision at one site.

The same operation — resolve the active persona file's declared skill names against the current command set for a child — is implemented three times: two inline `try { resolveSkillPaths } catch { throw }` blocks and one extracted `resolveRestoredSkills` that logs and returns `undefined`. They have already drifted (fatal vs. non-fatal), and the non-fatal copy's fallback produces finding 2's fail-open. One shared resolver with an explicit failure-policy parameter would make the intended semantics a single decision.

### 6. Unrecorded session-start reason counts as a fresh bind

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/persona-workspaces/index.ts:252-260` (`isFreshBind`), consumed at `:176`
- **Status:** dismissed
- **Resolution:** Changing the default to silent would require adjudicating an immutable test — `index.test.ts`'s override-notice case runs `before_agent_start` with no recorded reason and sanctions announcing. Real pi always dispatches `session_start` first and transcript dedup backstops; the risk is remote.

Interface 5 and Step 6 gate boot/override notices strictly to `startup`, `new`, `fork` — "resume and reload never announce." The implementation treats an unrecorded reason (`undefined`) as fresh and would announce. The code documents why this can't happen ("real pi always dispatches `session_start` before the first run") and transcript dedup backstops most cases, so practical risk is remote — but the default is biased toward announcing rather than staying silent, inverting the plan's fail-safe if pi's dispatch order ever changes or a manager swap occurs without a `session_start`.

### 7. Local scalar front-matter parser diverges from pi's YAML value semantics

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/persona-workspaces/declaration.ts:98-120` (`parseFlatScalars`/`parseScalarValue`)
- **Status:** resolved
- **Resolution:** Documented, not emulated (user ruling): the declaration contract in `declaration.ts` now states the flat-scalar semantics and the deliberate divergence from pi's YAML parser — inline comments are not stripped, escapes are not decoded, quotes act only as a matching outer pair.

Ruling (c) sanctions a local parser (the test harness mocks the pi package down to `getAgentDir`), and the delimiter/body handling faithfully mirrors pi's `extractFrontmatter`. But pi feeds the extracted block to real YAML (`yaml.parse`), while `parseScalarValue` keeps raw scalars minus matching quotes: inline comments are not stripped and escapes aren't decoded. A natural `kind: persona # interactive lead` silently fails the exact-marker check and the file is left as plain project context; `name: "Lead" # x` yields a name containing the comment. Since strict, predictable detection is this interface's core contract, the divergence is worth knowing; the declared contract ("flat `key: value` scalars") does contain it, hence nit.

### 8. The active persona file is read twice per child construction (TOCTOU / mixed capability set)

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/session-owner.ts:1273`, `extensions/subagents/agent-set.ts:560-563` (restore: `agent-set.ts:1167` + `560`)
- **Status:** resolved
- **Resolution:** The active persona file is read exactly once per child construction: producers (spawn, fork, resurrect, restore) resolve the winning capabilities and carry them on the spec (`personaTools`, `skillPaths`/`noSkills`, `model`); `createNodeRequest` consumes the spec and never re-reads the declaration, so an edit between reads cannot mix capabilities.

Each child construction resolves the workspace declaration twice — once in `spawnAgents`/`toRestoreSpec` (model, skills) and again in `createNodeRequest` (tool policy). If `<childCwd>/AGENTS.md` is edited between the two reads, the child gets a mixed construction (e.g. model/skills from the old declaration, tool allowlist from the new one) — violating "one active agent file, all or nothing." Passing the already-resolved capabilities through the spec would remove both the race and the second layer's re-derivation.

### 9. `pi.setModel`'s failure result is ignored during root model binding

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/persona-workspaces/index.ts:368-369`
- **Status:** resolved
- **Resolution:** `pi.setModel`'s result is checked (it returns `false` when the model's provider is unauthenticated): the run reports through the tier-diagnostics vocabulary and the persona's thinking level is no longer clamped onto the baseline model.

`setModel(model): Promise<boolean>` returns `false` when authentication is not configured for the model's provider. `bindDeclaredModel` awaits it, discards the result, then unconditionally applies `setThinkingLevel(binding.thinking)`. Scenario: a workspace declares `model: some-provider/model:high` where `some-provider` has no API key — the session silently runs on the baseline model with the persona's thinking level clamped onto that model, no diagnostic, while the boot notice says the persona took over. The child path surfaces `resolveCliModel` errors (`managed-child-session.ts:417`). A `false` result should at least raise the existing tier-diagnostic vocabulary and skip the thinking-level call.

## No Issues

Both passes ran and both produced findings, so this section is empty by design. Plan adherence: Steps 1–8 all traced to the diff (Step 8 done-with-deviations per finding 1); **test immutability is clean** — `declaration.test.ts`, `index.test.ts`, and `child-session-marker.test.ts` are unchanged since `pre-implementation-commit`, and `scoped-extension.integration.test.ts` carries exactly ruling (b)'s sanctioned 3-line assertion swap. Code correctness: no critical defects; the wholesale-winner semantics, per-run fresh-copy mutations, notice dedup against pi's real transcript shape, WeakMap marker semantics, and the `persona`→legacy `agent` shim were all verified sound.

## Process Note

The skill prescribes the code-correctness pass on the `frontier` model tier. That tier was unavailable (billing limit, 402) and the `smart` tier failed twice with a provider-side error, so the correctness pass ran on `medium`. The pass additionally verified runtime contracts against pi's actual `dist` (transcript entry shape, `before_agent_start` ingestion, `setModel` semantics, extension reload dispatch) and reproduced the full test suite. A re-run on `frontier` once available could surface findings beyond these.
