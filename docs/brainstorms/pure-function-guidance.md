# Pure Function Guidance

## The Idea

Embed design guidance into the planning and implementing skills to counteract LLMs' tendency to default to shared mutable state. Current models over-reach for shared state patterns because that's what dominates their training data — this leads to race conditions, unnecessary synchronization complexity, and designs that are harder to extend.

## Key Decisions

### Default to pure functions with explicit passing
The strong default for all generated code should be pure functions with data flowing through arguments and return values, not through shared state. This corrects the model's training-prior tendency toward shared-state-first design.

**Why:** The problem isn't occasional — it's pervasive across all kinds of code. It surfaces as bugs in production and as synchronization complexity in future planning sessions. The root cause is an early design choice that goes unchallenged because the model's default instinct is "put it somewhere shared, read it from there."

### Shared immutable state is fine
Shared state that is never mutated (config loaded once, constants, frozen data structures) does not carry the risks of shared mutable state and does not need special treatment.

**Why:** The danger is mutation, not sharing. Drawing the line at mutability is cleaner and more precise than trying to carve out categories of "acceptable" shared state like loggers or config.

### Shared mutable state requires user approval
When the model believes shared mutable state is genuinely the right design choice, it must surface the decision to the user with its reasoning before committing to it. This applies in both planning (architectural data flow decisions) and implementing (micro-design choices within steps).

**Why:** A hard ban would be wrong — shared mutable state is sometimes the right tool. But the door should be narrow. Requiring user approval shifts the burden of proof: the model has to argue *for* shared mutable state rather than defaulting to it. This creates an actual checkpoint rather than hoping the model self-corrects.

### Guidance as a strong design principle, not a rigid constraint
The guidance should be strong but not absolute. Rigid prompts prevent the model from using its own judgment for the cases where shared mutable state is appropriate.

**Why:** The goal is to shift the default, not to forbid a tool entirely. The user-approval checkpoint is the enforcement mechanism that keeps it honest.

## Direction

Add guidance to both the planning and implementing skills:

- **Planning skill:** A design principle that shapes how steps are structured. The planner should design data flow around explicit passing and pure functions. When shared mutable state seems warranted in the plan's architecture, surface it to the user for approval before writing the step.

- **Implementing skill:** An execution-time principle. When writing code, default to pure functions and explicit argument passing. If shared mutable state is being introduced — even in micro-design decisions within a step that the plan didn't explicitly call for — flag it to the user rather than quietly introducing it.

## Open Questions

- Exact wording and placement within each skill file (which section, how prominent).
- Whether the architecting skill should also carry this guidance, since it makes the structural decisions that planning then decomposes.
