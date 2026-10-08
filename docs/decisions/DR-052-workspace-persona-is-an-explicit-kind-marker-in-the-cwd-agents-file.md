# DR-052: Workspace persona is an explicit `kind: persona` marker in the cwd's own AGENTS.md

## Status
Accepted

## Context
Persona workspaces let a directory *be* a specialist: cd in, launch pi, and the session is the specialist from the first message — "the directory is the agent; booting in the directory is the whole interaction." That intent settled *that* declaration is ambient, but not *how* a directory declares it. The declaration form had to survive ordinary markdown files that already carry front matter (site generators, static tooling), live where the user's working context already lives, and be predictable enough that taking over a session is never accidental.

## Decision
A workspace persona is declared by the working directory's own `AGENTS.md` with exact front-matter marker `kind: persona`; the body is the persona (it replaces pi's system-prompt preamble) and the front matter carries the capability shape (`name`, `description`, `tools`, `model`, `skills`). Detection is strict: the cwd's `AGENTS.md` exactly — one directory deep, no ancestor walk, no subdirectory recursion.

Rejected: a CLI flag (`pi --agent scout`) — the ambient boot *is* the interaction, so anything you have to remember to type defeats the form; a project-config default — same objection plus a second config surface to keep in sync with the file; a reference-style marker (`agent: scout` resolving from the agents dirs) as the primary form — the workspace should be self-contained, and the four-tier agent-discovery walk is the wrong directory for a root-native declaration; shape-sniffing (`name` + `description` presence) — site-generator front matter would false-positive a persona hijack, and "explicit marker beats sniffing" is the contract that makes takeover non-accidental; `agent` as the marker key — too overloaded; mirroring pi's context-file ancestor walk — rejected for simplicity of reasoning: the persona is exactly one directory deep, so subdirectories are plainly themselves.

## Consequences
A persona file is unambiguous and self-contained; a non-persona AGENTS.md is left entirely alone (it stays ordinary project context). The `kind:` seam is reserved for future values: unknown `kind` values are silently ignored — never an error, never a persona — so new values can be introduced later without breaking existing files. Costs accepted: no inherited personas in nested directories, and the parser is flat-scalar by contract (documented divergence from pi's YAML value semantics — inline comments not stripped, escapes not decoded), chosen so detection stays strict and predictable.
