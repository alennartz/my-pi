---
name: debugging
description: "Use when encountering any bug, test failure, or unexpected behavior. Enforces root cause investigation before attempting fixes."
---

# Systematic Debugging

## Overview

Find the root cause before attempting a fix. Every time, no exceptions. Quick patches mask real problems, waste time, and introduce new bugs. A wrong guess followed by another wrong guess followed by another wrong guess is not debugging — it's thrashing.

The core discipline is simple: understand what's actually happening before changing anything. Resist the urge to guess-and-patch, even when the fix seems obvious. Especially when the fix seems obvious.

## Process

### Phase 1: Investigate

The goal is to understand what's happening and why. Do not propose fixes during this phase.

**Read the error carefully.** Stack traces, error messages, and warnings contain more information than most people extract from them. Read them completely. Note file paths, line numbers, error codes. Don't skim past warnings on the way to the error — they often explain it.

**Reproduce the problem.** Can you trigger it reliably? What are the exact conditions? If it's intermittent, gather more data rather than guessing. A bug you can't reproduce is a bug you can't confirm you've fixed.

**Check what changed.** Look at recent commits, dependency updates, config changes, environmental differences. Most bugs are caused by something that changed — find what.

**Trace backward to the root cause.** Bugs manifest deep in the call stack but originate elsewhere. When you find where something goes wrong, don't stop — ask what called it with bad data, then what called that, and keep tracing upward until you find the original source. The fix belongs at the source, not at the symptom. If you can't trace manually, add temporary diagnostic logging at component boundaries to reveal where data goes wrong.

**Compare against working examples.** Find similar code in the same codebase that works correctly. Identify every difference between the working version and the broken one, no matter how small. Don't assume any difference is irrelevant.

When this phase is complete, you should be able to articulate clearly what the root cause is and why it produces the observed behavior.

### Phase 2: Hypothesize and Test

**Form a single hypothesis.** State it clearly — what you believe the root cause is and why. Be specific, not vague.

**Test with the smallest possible change.** Change one variable at a time. If the hypothesis is wrong, you need to know it was wrong — not wonder whether your test was confounded by a second change you made simultaneously.

**If the hypothesis is wrong, form a new one.** Do not layer additional fixes on top of a failed attempt. Back out the change, return to the evidence, and reason from what you now know. Each failed hypothesis is new information — use it.

**Say when you don't know.** If you don't understand something, say so. Research it, gather more evidence, ask for help. Pretending to understand is the fastest path to a bad fix.

### Phase 3: Fix

**Write a failing test first.** Capture the bug in the simplest possible test case — one that fails now and will pass when the root cause is addressed. This proves the fix actually fixes the problem and prevents regression.

**Implement a single fix at the source.** Address the root cause you identified, not the symptom. One change, targeted at the origin of the problem. No bundled refactoring, no "while I'm here" improvements.

**Verify thoroughly.** The new test passes. Existing tests still pass. The original bug is actually resolved. If verification fails, return to Phase 2 — don't stack more changes.

## Escalation

If investigation reveals the problem is architectural — the bug is a symptom of a deeper design issue, or the fix would require large-scale refactoring across module boundaries — stop and bring this to the user. Explain what you've found, why you believe the issue is structural, and what the options are. Autonomous fixes should not result in massive refactors. This is a conversation, not a unilateral decision.

## Key Principles

- **Root cause first, always** — no fixes without understanding. Symptom fixes are not fixes.
- **One variable at a time** — change one thing, observe the result. Isolate cause and effect.
- **Trace to the source** — fix where the problem originates, not where it manifests.
- **Back out failed attempts** — don't layer fix on top of fix. Each attempt starts clean.
- **Escalate architectural problems** — if the fix is bigger than a bug fix, involve the human.
