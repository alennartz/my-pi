# Agentic TDD

## The Idea

When coding agents use TDD, they typically write tests and implementation in the same context with a detailed plan. This defeats TDD's purpose — the shared context means tests align with the implementation's assumptions rather than independently validating behavior. The agent exhibits confirmation bias: whether its interpretation of the plan is correct or not, both tests and code will agree with each other.

## Key Decisions

### Component-level behavioral tests, not unit tests
Tests target the public surface of meaningful components with realistic scenarios. They cover happy paths, boundary conditions, and error cases. No individual function unit tests (white-box, high maintenance churn), no end-to-end tests against running systems, no non-deterministic tests (e.g., concurrency unless deterministic in the tech stack). Reasoning: lower-level tests are inherently white-box, create maintenance burden as internals change, and are unnecessary if component-level coverage is thorough enough. Higher-level tests also naturally align with the context restriction goal — a test writer without implementation knowledge *can't* easily write internal-focused tests.

### Context separation between test writing and implementation
The test writer receives only architecture artifacts (component boundaries, interfaces, data flow) — no implementation plan, no detailed internal design. This is enforced through agent context boundaries, the same mechanism used today. The user can choose whether the test writer runs in a clean context or continues from the architecture session. Reasoning: if the test writer has implementation details, they'll write tests that mirror the implementation rather than independently verify behavior, reproducing the original problem.

### Test review as a human-interactive checkpoint
A dedicated test review phase validates tests against brainstorm intent and architecture before any implementation planning begins. Runs in a clean context or sub-agent. Escalates ambiguity between intent and test expectations to the user. Reasoning: catches impossible, unreasonable, or misaligned tests before the implementer starts — much cheaper than discovering problems mid-implementation. Also the only phase that deliberately holds both high-level intent and concrete tests to check alignment.

### Implementation planning happens after tests
Implementation planning takes architecture + reviewed tests as input, done in a clean context. This means tests genuinely drive the implementation design rather than the reverse. Reasoning: if implementation planning happens before tests, the plan might assume approaches that the independently-written tests make awkward, leading to rework. With tests-first planning, the planner knows exactly what behavioral constraints must be satisfied.

### Implementation cannot modify tests
The implementer gets the plan and tests, iterates until tests pass. Tests are immutable — but the implementer can escalate to the human if a test seems unsatisfiable. Reasoning: allowing test modification undermines the entire separation. The escape valve (human escalation) handles genuine issues without giving the agent unilateral power to weaken the test suite.

### Always-on, not opt-in
The TDD pipeline replaces the current workflow entirely. Every task goes through it. Reasoning: simpler to maintain one pipeline, and the overhead is acceptable given the value of independent test validation.

### Branch-based development
This work happens on a new branch, not main, given the scope of pipeline changes.

## Direction

Replace the current workflow pipeline (brainstorm → architect → plan → implement → review → cleanup) with a TDD-oriented pipeline:

1. **Brainstorm** — explore intent, interactive with user
2. **Architecture** — component boundaries, interfaces, data flow
3. **Test writing** — behavioral/component tests, restricted to architecture context only
4. **Test review** — validates tests against brainstorm + architecture intent, interactive with user, clean context
5. **Implementation planning** — gets architecture + reviewed tests, clean context
6. **Implementation** — iterates until tests pass, cannot modify tests, can escalate to human
7. **Code review** — existing behavior, unchanged
8. **Cleanup** — existing behavior, unchanged

Each phase has deliberately curated context boundaries. The test writer never sees implementation details. The test reviewer holds intent + tests to check alignment. The implementer works from plan + tests with no power to change the tests.

## Open Questions

- Test review prompting details — how exactly to prompt the test review agent to check alignment between intent and tests (deferred to architecture phase)
- Exact context curation per phase — which specific artifacts each agent receives
