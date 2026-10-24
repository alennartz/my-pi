# Model Selection

Read this reference when an explicit model or specialist persona is under consideration. Tier names are configurable aliases. An omitted `agents[].model` inherits the current session model.

## Persona precedence

Prefer a matching specialist persona when one is available. Pass its name in `persona`. Use a default general-purpose agent when no matching specialist fits. A persona's model pin wins over an explicit `model` argument. An explicit model fills the gap only when the active persona declares no model.

For reusable persona definitions, read [specialist-design](../specialist-design/SKILL.md).

## Tier choices

Use a tier by task shape when a deliberate model choice helps:

- **`cheap`** — straightforward tasks where cost or latency matters.
- **`medium`** — routine tasks and interactive planning.
- **`smart`** — difficult reasoning, broad planning, or explanation and synthesis.
- **`frontier`** — unusually difficult analysis.

Tier names resolve from the user's configured aliases. A concrete model id passes through unchanged. Use the `list_models` tool when a concrete model id is required.

## Adjustments

- Architecture and implementation planning is interactive and human-led. Start at `medium`; use `smart` for broader scope. Do not choose `frontier` only because the task is planning.
- Factual documentation updates start at `cheap`; use `medium` for explanation or synthesis, and `smart` for design trade-offs.
- Conflicting review feedback is an escalation case. Keep the human as adjudicator and escalate only when the human decides that more reasoning is needed.
