# DR-024: Context Boundaries as TDD Enforcement

## Status
Accepted

## Context
When a coding agent writes both tests and implementation in the same context, it exhibits confirmation bias — both artifacts agree with each other regardless of whether the interpretation is correct. The TDD pipeline needed a mechanism to ensure tests are written independently of implementation knowledge.

## Decision
Use agent context boundaries — the same mechanism already used for mandatory clean contexts between pipeline phases — as the enforcement layer. The test writer receives only the codemap and the architecture section of the plan (component boundaries, interfaces, data flow). It never sees the implementation plan, detailed internal design, or implementation code. This is enforced by the `test-write → test-review` and `test-review → impl-plan` transitions being mandatory clean contexts, and the `architect → test-write` transition being flexible (user's choice).

Rejected alternatives: runtime file-access restrictions (complex to implement, brittle), prompt-level instructions to "ignore implementation details" (unenforceable — the information is still in context), and separate repos or branches for tests (too much operational overhead for the same guarantee).

## Consequences
The guarantee is structural, not behavioral — the test writer literally cannot reference implementation details it was never given. This means interface descriptions in the architecture must be self-contained and thorough, since the test writer has no other source of truth. The trade-off is that context boundaries also discard potentially useful continuity (e.g., nuanced discussion from the architecture session), which is why the `architect → test-write` transition is flexible rather than mandatory.
