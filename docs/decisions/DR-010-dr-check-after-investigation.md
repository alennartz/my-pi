# DR-010: DR Check Positioned After Investigation in Architect Phase

## Status
Accepted

## Context
When adding decision record awareness to the architecting skill, a key question was *when* in the process the agent should read existing DRs — upfront before any work, or after the investigation step.

## Decision
The DR check happens after investigation (step 1) and before the decision conversation (step 3). The agent needs full context about the current work (codemap, brainstorm, code) before it can evaluate which DRs are relevant. Reading them after investigation means the agent knows what it's looking for and can connect DRs to what it found in the code.

## Consequences
The agent reads DRs with informed eyes rather than blind — it can filter for relevance and connect DRs to actual code patterns it discovered. Adds one step to the architect process but avoids wasted reads of unrelated DRs.
