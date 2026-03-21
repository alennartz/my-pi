# Review: Distributable Agent Definitions

**Plan:** `docs/plans/distributable-agent-definitions.md`
**Diff range:** `31cb80612..d6783ef`
**Date:** 2026-03-21

## Summary

The plan was faithfully implemented across all seven steps with no meaningful deviations. The four-tier merge logic, package discovery, caching, and trust dialog removal all match the plan's intent. One code correctness issue: packages that declare only `pi.agents` (no extensions, skills, prompts, or themes) are silently invisible because discovery relies on resource metadata from those four types to find package baseDirs.

## Findings

### 1. Agent-only packages are silently ignored

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agents.ts:136-148`
- **Status:** dismissed

`discoverPackageAgents()` discovers package baseDirs by iterating over `resolved.extensions`, `resolved.skills`, `resolved.prompts`, and `resolved.themes` — collecting baseDirs from entries where `origin === "package"`. If a package declares `pi.agents` but none of the other four resource types, it produces zero resource metadata entries, so its baseDir is never collected and its agents are silently skipped.

This is a real-world scenario: a package author could reasonably create an agents-only package (e.g., a collection of specialist agent definitions with no extension or skill code). The current approach works for packages that happen to also declare at least one other resource type, but creates a silent failure for agents-only packages. A future fix could add `resolved.agents` to the package manager's resolution pipeline, or enumerate installed package directories directly rather than deriving them from other resource metadata.

## No Issues

Plan adherence: no significant deviations found. All seven steps were implemented as specified — type widening, new discovery function, signature change with four-tier merge, session_start caching, call-site plumbing, and trust dialog removal all match the plan's architecture and intent. Minor adaptations (Step 7's verify text updated for code review context) are reasonable implementation-time adjustments.
