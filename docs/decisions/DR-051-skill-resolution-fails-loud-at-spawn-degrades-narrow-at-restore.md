# DR-051: Skill resolution fails loud at spawn, degrades narrow at restore

## Status
Accepted

## Context
Review finding 2 on persona-workspaces exposed an asymmetric failure problem: a typo'd or stale `skills:` list hard-fails a fresh spawn (the author is present and can fix it), but the restore path treated resolution errors as non-fatal and fell back to ordinary skill discovery — a stale whitelist silently granted the restored child *every* skill. The wrong direction of leniency: lenient exactly where a widened set is dangerous and unrecoverable, strict where a human is standing by to correct a typo. Resolving this forced the shared resolver (`resolvePersonaSkillPaths`) to make failure policy an explicit parameter instead of an implicit per-callsite drift, which is where the inconsistency had come from in the first place (the same drift pattern as duplicated model-ref resolution).

## Decision
The failure policy is split by path. Spawn, fork, and resurrect stay **fatal**: an unresolvable skill name aborts the spawn loudly — authoring errors surface at authoring time. Restore **degrades narrow**: unresolvable names are dropped and logged, and the resolved remainder is the complete set the child gets — never wider than the declared whitelist, and an all-stale list yields zero skills rather than falling back to discovery. This required a representation fix alongside: a `noSkills` flag distinguishes "declared set, even if empty" from "no declaration at all", since `[]` previously meant "no filtering" and made fail-closed impossible to express.

Rejected: uniform-fatal everywhere (renaming or removing a skill would brick restores of old sessions — restore must tolerate staleness, which the pre-existing "a stale skill list is logged, never fatal" comment already recognized); uniform-subset everywhere (silently swallowing typos at spawn hides authoring mistakes from exactly the person who can fix them); zero-skills-on-any-error at restore (punishes the session for one stale name without buying capability safety — subset resolution is already never-wider-than-declared). User ruling confirmed the split: subset semantics on restore only, spawn behavior unchanged.

## Consequences
Restores are resilient and never widen a whitelist; spawn-time typos stay loud. Cost: the asymmetry itself — a skill name that fails at restore is silently dropped, so a stale deployment can run with fewer skills than its author intended (logged, not surfaced). The policy is now a one-parameter call-site choice, so any new spawn path must decide deliberately rather than inherit drift; a future caller that wants "subset everywhere" is a one-line flip per call site.
