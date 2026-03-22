# DR-018: Scout Verb as Delegation Trigger in Skill Prose

## Status
Accepted

## Context
Investigation phases in workflow skills (architecting, planning) need the primary agent to understand the codebase before making decisions. Previously, skills said "read the impacted modules" and the primary did all file-reading itself, consuming context on raw code. The scout agent definition already existed (cheap model, read-only, returns prose with file references), but nothing in the skill prose signaled when to use it.

## Decision
Skills use the word "scout" as a verb — e.g., "scout the impacted modules" instead of "read the impacted modules" — wherever investigation should be delegated. The primary sees the verb trigger and spawns a scout agent rather than reading files directly. No structural changes to skill format; just a vocabulary shift. Scouts return prose with file references so the primary can surgically read only what matters.

## Consequences
A single word carries orchestration intent without inventing a new config format or annotation system. The convention is fragile in the sense that it's implicit — a new skill author might not know "scout" is meaningful. But it's also lightweight and natural: skills read as plain English, and the orchestrating-agents skill documents the pattern. If the convention breaks down, it degrades gracefully — the primary just reads files itself.
