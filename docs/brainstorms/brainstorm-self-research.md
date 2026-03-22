# Brainstorm: Self-Research Before Asking

## The Idea

The brainstorming skill sometimes asks the user questions it could answer on its own using available tools — reading files, running commands, or searching the web. Not frequent, but enough to erode trust. The skill's process is entirely dialogue-oriented and never tells the agent to look things up first.

## Key Decisions

- **Facts vs. intent is the dividing line.** Questions about facts and existing context (code structure, how something works today, what's out there) should be researched by the agent. Questions about intent, priorities, and preferences should be asked of the user. The agent is smart enough to distinguish these — no need to spell out elaborate heuristics.

- **Generic tool language, no skill references.** The skill should encourage using available tools (reading files, running commands, searching online) without naming specific skills like brave-search. This keeps it portable — works with whatever tools are available, fails gracefully when they're not.

- **Don't over-prescribe the UX.** No need to tell the agent whether to surface what it found or stay silent. Let the model decide how to weave researched context into the conversation naturally.

- **Minimal change.** This is a small language addition to the existing skill, not a structural overhaul. A principle or short instruction, not a new process phase.

## Direction

Add language to the brainstorming skill that sets the expectation: before asking the user a factual or context question, check whether you can answer it yourself with your tools. Keep it brief, generic, and positioned as a general principle rather than a per-phase rule.

## Open Questions

- Exact placement in the skill (Key Principles section vs. inline in the process steps vs. a short standalone section) — to be decided during planning.
