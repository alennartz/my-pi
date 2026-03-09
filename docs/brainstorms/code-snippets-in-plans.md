# Brainstorm: Code Snippets in Plans

## The Idea

The planning and architecting agents avoid code snippets in plan artifacts, even when code would be clearer than prose. There's no explicit rule forbidding it, but the skills' format and emphasis on prose create a strong implicit signal. The result: agents back away from code snippets they'd naturally want to include, forcing themselves into verbose prose descriptions of things that would be unambiguous as a short type definition or interface signature.

## Key Decisions

### 1. The original concern is valid and stays

The reason code was implicitly discouraged: writing implementations in plans pre-empts TDD. If the plan contains function bodies, the implementing agent copies them verbatim instead of writing tests first and letting the implementation emerge. This undermines the entire test-driven workflow. That concern is real and unchanged.

### 2. Default to prose, use code when clearly superior

The fix is making the rule explicit and nuanced rather than leaving it as an implicit blanket ban. Prose is the default. Code snippets are appropriate when they communicate **shape** more clearly than prose — primarily:

- **Interfaces and type signatures** — contracts between pieces
- **Data structures** — types/objects that carry data, even module-internal primary ones
- **Important function signatures** — the ones that define the shape of the work (not exhaustive listings of every method)

Code is **not** appropriate for:

- Function bodies / implementations
- Algorithms or logic
- Exhaustive listings of every signature in a module
- Anything where writing it out is effectively doing the implementation

### 3. Tell the agent *why*

Include the reasoning about TDD pre-emption directly in the skill text. An agent that understands "don't pre-empt TDD by writing implementations" can judge the line between shape and behavior on its own. An agent that only knows "don't put code in plans" will over-apply the rule conservatively. The *why* enables better judgment.

## Direction

Update both the architecting and planning skills with an explicit, reasoned guideline about when code snippets are appropriate in plan artifacts. The guideline should state the TDD concern, the "prefer prose, use code when clearly superior for shape" principle, and concrete examples of what's appropriate vs. not.

## Open Questions

None.
