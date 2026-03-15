# Review: Subagent Companion Skills

**Plan:** `docs/plans/subagent-skills.md`
**Diff range:** `bbf87409..1a3e91e`
**Date:** 2026-03-15

## Summary

Both skills faithfully implement the plan — all sections, cross-references, and structural requirements are present. Claims about tool parameters, notification formats, topology validation, channel enforcement, and deadlock detection are accurate against the extension code. One factual inaccuracy found: the specialist-design skill claims model inheritance behavior that the code doesn't implement.

## Findings

### 1. Model inheritance claim doesn't match code behavior

- **Category:** code correctness
- **Severity:** warning
- **Location:** `skills/specialist-design/SKILL.md:34`
- **Status:** open

The skill states: "Omit to inherit the parent's model." In `buildAgentArgs` (`agents.ts`), omitting the `model` field means no `--model` flag is passed to the child process. The child uses pi's configured default model — not the parent's current model. If the parent was started with `--model claude-opus-4` or switched models mid-session, children spawned without an explicit `model` field will use whatever pi's default is, not `claude-opus-4`. Should say "use pi's configured default model" instead of "inherit the parent's model."

Note: this wording originates from the architecture ("omit to inherit the parent's model"), so the skill faithfully reproduces the plan — but the plan's claim doesn't match the code.

## No Issues

Plan adherence: no significant deviations found. All three steps completed as specified — both skill files have the required frontmatter, all planned sections are present with correct content, and the commit contains exactly the two new SKILL.md files plus plan status updates. Tool parameters (`subagent` fields `id`/`agent`/`task`/`channels`, `send` fields `to`/`message`/`expectResponse`, `respond` fields `correlationId`/`message`), notification XML (`<agent_complete>`, `<group_idle>`, `<agent_message>`), and topology behaviors (`validateTopology` reference checking, parent auto-injection, broker channel enforcement, `DeadlockGraph` cycle detection via DFS) all match the extension code.
