# Brainstorm: Package Onboarding

## The Idea

This pi package needs two things it doesn't have today: (1) an `AGENTS.md` carrying personal behavioral conventions that apply everywhere the package is installed, and (2) an `/onboard` prompt template that documents the package's features and guides users through setup.

## Key Decisions

### AGENTS.md is for personal conventions, not package documentation
The `AGENTS.md` ships with the package and contains behavioral guidance for the agent — how to interact with the user. It does not document the package's own features. Users copy it into their project (`.pi/AGENTS.md`, project root `AGENTS.md`) or global config (`~/.pi/agent/AGENTS.md`). The package can't inject into the system prompt automatically, so the user owns the setup.

**Why:** Transparency and user control. Silently modifying the system prompt via `before_agent_start` works but is opaque. The user should own their `AGENTS.md` and be able to tweak it. The package is a delivery vehicle, not a hidden override.

### The core convention: pause at the explore→act boundary
Whenever the agent transitions from an exploratory/discussion phase (brainstorming, investigating, diagnosing, planning) to an action phase (writing files, running commands, editing code), it must pause and present what it's about to do in digestible chunks before proceeding. Each chunk should be ~200-300 words max, and the agent waits for user feedback before moving to the next chunk.

**Why:** The user consistently sees agents dump walls of text and then launch into action without a checkpoint. This applies across all contexts — workflow skill transitions, debugging fix proposals, mid-task course changes. The boundary between "building understanding" and "doing things" always deserves a pause.

### /onboard is the feature tour and setup guide
A prompt template (`/onboard`) that explains what the package provides and how to set it up. Covers the workflow pipeline, Azure Foundry provider, standalone skills (codemap, debugging), and instructs the user to install the `AGENTS.md`.

**Why:** The package's features aren't self-documenting to a new user (or future-you on a fresh machine). A prompt template is immediately available after install, requires no extension code, and works as both a refresher and an introduction.

## Direction

Two artifacts to build:

1. **`AGENTS.md`** at the package root — one behavioral rule about pausing at explore→act boundaries with ~200-300 word chunks. Kept minimal; more conventions can be added over time.
2. **`prompts/onboard.md`** — prompt template that documents the full package (workflow pipeline, Azure provider, standalone skills, TUI components) and walks the user through copying the `AGENTS.md` into their config.

## Open Questions

- Should the `/onboard` template actively offer to copy the `AGENTS.md` content for the user (e.g., "shall I add this to your project's AGENTS.md?"), or just show it and let them handle it?
- As more conventions accumulate in `AGENTS.md`, should they be categorized (e.g., interaction style, code style, workflow conventions), or kept as a flat list?
