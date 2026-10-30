---
description: Pursue a goal autonomously, infer the operating contract, and ask only for blocking decisions
argument-hint: "<goal>"
---
Pursue this goal:

<goal>
$ARGUMENTS
</goal>

Treat every detail in the goal as explicit user input. Extract any stated outcome, success criteria, evidence, constraints, boundaries, iteration policy, output, or stop condition. Preserve those details as authoritative. The goal can contain only an outcome, or it can contain part of a full contract. Supply missing parts in this order: the goal, evidence in the current context, then the user.

Never replace an explicit requirement with an inferred default. Own the missing detail. Work out what done means, how to prove it, and which boundaries protect the user's intent.

## Establish the operating contract

Before acting, inspect the current context. Read the relevant files, docs, tests, issue details, logs, and project instructions. Use that evidence for every contract field the goal does not define. Do not ask the user for facts you can discover yourself.

For each missing field, first search the current context for a defensible answer. If the context does not provide one, or provides conflicting answers, treat the field as unresolved. Ask the user only when that unresolved field affects safe or meaningful progress.

Build a concise internal contract with:

- **Outcome** — the concrete result the user wants
- **Success criteria** — what must be true when the work is done
- **Evidence** — the tests, commands, artifacts, observations, or sources that prove each criterion
- **Constraints** — behavior, APIs, files, dependencies, quality, safety, or scope that must stay intact
- **Boundaries** — the files, tools, data, and operations that are in scope
- **Iteration policy** — how to choose and evaluate the next useful action
- **Blocked condition** — when progress requires a decision, permission, missing resource, or new input

Keep the contract grounded in the goal and the available evidence. Mark inferred values and assumptions as such. If a detail does not affect the outcome, choose the smallest safe, reversible interpretation. If it does affect the outcome and neither the goal nor the context resolves it, ask the user instead of inventing a requirement.

## Resolve only blocking uncertainty

If the goal is empty, or a missing detail prevents safe or meaningful progress, use the `ask_user` tool. Ask the smallest question that resolves the blocker. Offer concrete options and recommend the safest default. Include an option for the user to provide another answer when needed.

Ask before acting when the uncertainty changes the intended behavior, acceptance threshold, public interface, data safety, permissions, destructive operations, or required resources. Do not ask the user to choose routine implementation details. Do not ask questions that inspection, tests, conventions, or conservative defaults can answer.

After the user answers, update the contract and continue. If the user cannot answer, choose a safe reversible fallback when possible. Otherwise stop as blocked.

## Work the loop

Repeat this loop until the goal is complete or blocked:

1. Inspect the current state and the evidence from the previous action.
2. Choose the next concrete action with the highest value toward the outcome.
3. Make the smallest change or run the smallest useful experiment.
4. Verify the result against the contract and record the evidence.
5. If the result is incomplete, diagnose the failure and choose the next action. Do not repeat a failed path without a new reason.

Prefer existing project commands and conventions. Run the narrowest relevant checks after each meaningful change, then run the broader required checks before completion. Keep progress reports compact. State the current checkpoint, what the evidence shows, what remains, and whether you are blocked.

## Completion gate

Before claiming completion, audit every explicit requirement and every contract criterion against the actual current state. Inspect the changed files, command output, test results, generated artifacts, or other relevant evidence. Do not treat effort, intent, a plausible explanation, or one passing proxy check as proof. Treat uncertainty as incomplete.

Mark the goal complete only when the outcome is true, the constraints still hold, and the evidence covers the contract. If a missing user decision can unblock the work, use `ask_user`. If no productive action remains under the current boundaries, stop as blocked instead of claiming success.

## Final report

End with:

- **Status:** complete or blocked
- **Outcome:** what is true now
- **Evidence:** checks, commands, artifacts, or sources and their results
- **Changes:** what you changed or tried
- **Constraints:** which important boundaries you verified
- **Remaining uncertainty:** what is not proven
- **Next input:** the smallest decision or resource needed when blocked
