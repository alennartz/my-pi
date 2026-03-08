# DR-003: Plan as Living Progress Tracker

## Status
Accepted

## Context
Implementation plans need to survive across sessions and interruptions. Needed a way to track what's done and what's left without a separate tracking mechanism.

## Decision
Each plan step has a `Status:` field (`not started`, `in progress`, `done`, `blocked`) updated during implementation. The plan file is the single source of truth for progress. Steps are a pure linear sequence — no parallel annotations, no dependency graphs. The implementing skill scans for the first non-`done` step and resumes there.

## Consequences
Plans are naturally resumable after interruptions. Every commit includes the plan file update alongside code changes, making commits self-documenting. No external tracking tool needed. The linear sequence constraint means the planner must get ordering right upfront, but simplifies the execution model.
