# DR-012: Supersession Is a Mandatory User Conversation

## Status
Accepted

## Context
DRs represent project-level decisions with substantive reasoning. When the architect phase discovers that a new decision contradicts an existing DR, the agent needs a protocol — should it autonomously override, flag it as a suggestion, or require explicit user consent?

## Decision
Superseding a DR is always a mandatory conversation with the user. The agent must stop, surface the conflict explicitly (which DR, what it says, what contradicts it), and let the user decide. Never silently override. If the user agrees, the supersession is captured in the plan's DR Supersessions section for cleanup to process.

## Consequences
The user retains control over project-level decisions. No DR can be silently invalidated by an agent run. Adds friction to the architect phase when conflicts arise, but that friction is the point — these are decisions that were made for substantive reasons.
