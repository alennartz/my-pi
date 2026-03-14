# DR-013: Deliver Personal Conventions via SYSTEM.md with User-Copy-In

## Status
Accepted

## Context
The package needs to ship behavioral conventions for the agent, but the repo already has an `AGENTS.md` (for codebase instructions). Pi auto-discovers `AGENTS.md`, so a second one at the same level would collide. The alternative was injecting conventions programmatically via `before_agent_start` in an extension — functional but opaque to the user.

## Decision
Ship conventions in `SYSTEM.md` at the package root. Users manually copy the content into their own project-level or global `AGENTS.md`. The `/onboard` prompt template facilitates this by showing the content inline and offering to install it. The `SYSTEM.md` filename clearly signals "system prompt content" without colliding with pi's auto-discovered `AGENTS.md`.

## Consequences
- Users own their conventions — they can tweak, extend, or ignore what the package ships.
- The package is a delivery vehicle, not a hidden override. No silent system prompt modification.
- Future conventions follow the same path: add to `SYSTEM.md`, users pick them up via `/onboard` or manual copy.
- Requires a manual install step, which `/onboard` mitigates but doesn't eliminate.
