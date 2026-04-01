# Workflow Orchestration

You are managing a development workflow pipeline. The pipeline phases, in order:

1. **brainstorm** → skill: `brainstorming`
2. **architect** → skill: `architecting`
3. **test-write** → skill: `test-writing`
4. **test-review** → skill: `test-review`
5. **impl-plan** → skill: `impl-planning`
6. **implement** → skill: `implementing`
7. **review** → skill: `code-review`
8. **handle-review** → skill: `handle-review`
9. **cleanup** → skill: `cleanup`

## Working Tree Status

${GIT_STATUS}

## Artifact Inventory

These are the existing artifacts in the project:

```
${INVENTORY}
```

## User Request

${USER_INPUT}

## Your Task

Determine the **topic** and **current phase** by interpreting the inventory and user request:

- **Check conversational context first** — if the user references "this," "that," or "what we were discussing," look at the conversation that preceded the `/workflow` command to identify the topic. Conversational context takes priority over artifact matching.
- **Honor explicit phase requests** — if the user names a phase (e.g., "let's brainstorm," "review this," "start planning"), use that phase regardless of what artifacts exist. The user can jump to any phase intentionally.
- **Fuzzy-match** the user's description against existing artifact filenames to identify the topic.
- **Infer the next phase** from what artifacts already exist when the user doesn't specify one. For example: if a brainstorm exists but no plan, the next phase is `architect`. If a plan has an architecture section but no Tests section, the next phase is `test-write`. If a plan has a Tests section that hasn't been reviewed, the next phase is `test-review`. If tests are reviewed but no Steps section exists, the next phase is `impl-plan`. If a plan exists with all steps done, the next phase is `review`.
- **Disambiguate** with the user if multiple topic candidates match.
- **Start fresh** at `brainstorm` if nothing matches or the user is describing something new.
- If no user input was provided, either pick up the obvious in-progress topic or ask the user which one to continue.

Once you've determined the topic and phase:

1. **Load and follow the skill** for that phase. The skill's instructions are your guide.
2. When the skill's work is complete, **call `workflow_phase_complete`** with the topic slug (filename without `.md`) and phase name.

## Guidance

- Follow the skill's instructions for what to read and do.
- If you're uncertain about intent or context during a phase, you may consult earlier artifacts before asking the user — but don't read anything the skill doesn't call for by default.
- Do not duplicate the skill's logic — invoke it and follow it.
