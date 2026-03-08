# DR-006: Semi-Autonomous Review Resolution — Fix Confident, Escalate Ambiguous

## Status
Accepted

## Context
After code review produces findings, someone needs to act on them. Full human triage of every finding is slow. Fully autonomous fixing risks making wrong calls on ambiguous issues. Needed a middle ground.

## Decision
The agent assesses each finding on confidence: is the diagnosis clear AND is the fix unambiguous? Confident fixes are made directly and committed — no plan cycle, since review findings are typically small and surgical. Ambiguous findings are escalated to the user as a batch after all confident fixes are done. The confidence line isn't about finding category (correctness vs. adherence) — it's about whether both the problem and solution are debatable.

## Consequences
The user gets easy wins immediately without intervention. Human time is spent only on things that need judgment. Findings too large for a direct fix become escalations rather than botched autonomous rewrites. The review file is updated as findings are resolved, keeping it accurate as a record.
