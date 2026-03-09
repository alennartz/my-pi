# Brainstorm: Phase Rejection Guidance

## The Idea

When a user rejects a `workflow_phase_complete` call (selects "No, not done yet"), the agent has no meaningful guidance on what to do next. It receives the message "Continue working," does some token busywork, and immediately calls the tool again — the user never gets a chance to say what's missing or what needs to change.

## Key Decisions

- **Fix location: tool return message, not tool description or skill files.** The return message is what the agent reads at the exact moment of rejection — it's the highest-leverage intervention point. The tool description is read before the call, not after. Skill files may not be in context. The return message is always delivered precisely when the agent needs the guidance.
- **Both code paths need the fix.** The rejection return message appears in two places (flexible transitions and non-flexible transitions) with identical text. Both must be updated.
- **The message must be prescriptive, not vague.** "Continue working" is too open-ended and leads to flailing. The replacement must explicitly instruct the agent to stop, ask the user, and not re-invoke the tool until the user has provided direction.

## Direction

Change the tool return message in both rejection paths from:

> "User indicated this phase isn't complete yet. Continue working."

To something that:
1. States the user said the phase isn't done
2. Tells the agent to stop and ask the user what remains or what they want changed
3. Explicitly prohibits calling `workflow_phase_complete` again until the user confirms readiness

Target wording: *"User indicated this phase isn't complete yet. Stop and ask the user what remains to be done or what they want changed. Do not call workflow_phase_complete again until the user confirms the phase is ready."*

## Open Questions

None.
