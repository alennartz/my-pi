# DR-002: Three-Phase Design Pipeline — Brainstorm, Architect, Plan

## Status
Accepted

## Context
Needed to decompose the path from "idea" to "implementable steps" into distinct phases. A single planning step conflates non-technical exploration with technical decisions with concrete sequencing, making each harder.

## Decision
Split into three phases: brainstorm (non-technical exploration of what and why), architect (technical decisions grounded in real code — modules, patterns, interfaces, tech choices), and plan (concrete ordered steps specific to files and changes). The architect writes the first half of `docs/plans/<topic>.md`; the planner appends steps below. Single artifact, not scattered across files.

## Consequences
Each phase has a clear scope ceiling — brainstorm doesn't touch code, architect doesn't sequence steps, planner doesn't make new architectural decisions. The shared artifact means no information loss between phases. Brainstorm input is optional — the pipeline can be entered at any phase when the prerequisite context is available.
