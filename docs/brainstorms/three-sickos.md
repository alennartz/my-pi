# Brainstorm: Three Sickos

## Idea

Add Spaghetti Sicko and Test Sicko beside Comment Sicko. The three are aggressive, report-only auditors. They improve maintainability by reducing comments, production-code tangles, or test-suite bulk. They do not edit code.

## Direction

Keep `improve-code` as its own workflow. It explores architectural deepening and guides design work after the user selects a candidate. Some overlap with Spaghetti Sicko is acceptable because their goals differ: `improve-code` explores architecture; Spaghetti Sicko hunts for smaller, clearer code.

All Sickos review supplied files first. If none are supplied, they review the current diff against `main`. They do not scan the whole repository unless the task asks for it. Use Comment Sicko’s forceful voice and report-only stance, with few real exceptions.

## Key decisions

- **Spaghetti Sicko prioritizes tangled control flow, then coupling.** Both are in scope, but flow comes first. Flag concrete opportunities to remove or simplify structure while making the code easier to maintain. Do not turn this into general style review.
- **Test Sicko targets brittle, implementation-coupled tests and suite bloat.** Find tests or assertions to remove or simplify. Preserve tests that protect unique observable behavior. Do not add missing tests or act as a general test writer.
- **Every finding must reduce the reviewed scope and improve maintainability.** A local rewrite can add lines only when the full proposed change in scope gets smaller. Do not surface maintainability-only changes that grow the scope. Do not estimate line savings.
- **Findings stay forceful and evidence-based.** Name the exact target and explain why removing or simplifying it improves maintainability. Do not hedge unnecessarily or invent findings. Keep exceptions few and tied to real behavior, safety, public contracts, or external constraints.
- **The agents report; they do not act.** This keeps them focused on diagnosis and matches Comment Sicko. The user can choose what to change.

## Open questions

### Sharp questions

None remain about intent or scope.

### Fog

Exact report layouts, opening lines, and each agent’s small exception list remain to define when drafting the agent prompts.
