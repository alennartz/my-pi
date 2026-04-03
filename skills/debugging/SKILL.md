---
name: debugging
description: "Use any time the user reports a problem — something not working, broken, wrong, unexpected, or off. This is the go-to skill whenever the user describes a symptom rather than requesting a specific change. Covers everything from vague 'this doesn't work' reports to specific error messages, stack traces, test failures, crashes, wrong output, regressions, or build errors. Also use when stuck — a previous fix didn't work, the same problem keeps coming back, or you're looping on failed attempts. Enforces root cause investigation before any fix."
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

**Consider the data structure angle.** Tracing control flow isn't the only lens. Sometimes — especially when the bug is a design issue rather than an algorithmic logic error — it's more productive to look at the problem from the perspective of data structures and their lifecycles: what exists, who owns it, what invalidates it. This framing can yield more intuitive explanations and higher-quality root cause fixes for that class of problem.

**Compare against working examples.** Find similar code in the same codebase that works correctly. Identify every difference between the working version and the broken one, no matter how small. Don't assume any difference is irrelevant.

When this phase is complete, you should be able to articulate clearly what the root cause is and why it produces the observed behavior.

### Phase 2: Hypothesize and Test

**Form a single hypothesis.** State it clearly — what you believe the root cause is and why. Be specific, not vague. A good test: can you name a specific location to check and what you'd expect to see? If verifying your hypothesis requires broad exploratory reading, it's not specific enough — narrow it before you start reading.

**Test with the smallest possible change.** Change one variable at a time. If the hypothesis is wrong, you need to know it was wrong — not wonder whether your test was confounded by a second change you made simultaneously.

**If the hypothesis is wrong, form a new one.** Do not layer additional fixes on top of a failed attempt. Back out the change, return to the evidence, and reason from what you now know. Each failed hypothesis is new information — use it.

**Say when you don't know.** If you don't understand something, say so. Research it, gather more evidence, ask for help. Pretending to understand is the fastest path to a bad fix.

### Phase 3: Decide — Fix or Consult

Before touching any code, decide whether you should fix autonomously or present your findings to the user first.

**Fix autonomously** when all of these are true:
- The root cause is clear — one obvious explanation, not competing theories
- The fix is small and mechanical — a typo, a wrong variable, a missing null check, an off-by-one
- There is only one reasonable way to fix it
- The fix does not change intended behavior, APIs, or semantics
- You fully understand the code you're changing

**Stop and consult the user first** if any of these are true:
- Multiple plausible root causes — you're not sure which one is right
- The fix changes behavior or semantics, not just correcting a clear mistake
- There's a judgment call about intent — it's unclear whether the current behavior is a bug or was deliberate
- The fix touches code you don't fully understand
- The fix has side effects beyond the immediate bug
- The fix would require changes across multiple modules or files
- The problem is architectural — a symptom of a deeper design issue

When consulting, present: what you found, why you believe it's the root cause, what the fix would be, and why you want confirmation before proceeding. Be specific.

### Phase 4: Fix

Only reached if Phase 3 determined you should fix autonomously, or the user confirmed you should proceed.

**Write a failing test first.** Capture the bug in the simplest possible test case — one that fails now and will pass when the root cause is addressed. This proves the fix actually fixes the problem and prevents regression.

**Implement a single fix at the source.** Address the root cause you identified, not the symptom. One change, targeted at the origin of the problem. No bundled refactoring, no "while I'm here" improvements.

**Verify thoroughly.** The new test passes. Existing tests still pass. The original bug is actually resolved. If verification fails, return to Phase 2 — don't stack more changes.

### Phase 5: Recap

After the fix is verified (or after presenting findings if you consulted instead of fixing), give a brief summary:

- **Root cause:** One or two sentences — what was actually wrong and where.
- **Fix applied:** What you changed and why it addresses the root cause.
- **Verification:** What you checked to confirm the fix works.

Keep it short. This is a recap, not a report. The user should be able to glance at it and understand what happened.

## Key Principles

- **Root cause first, always** — no fixes without understanding. Symptom fixes are not fixes.
- **One variable at a time** — change one thing, observe the result. Isolate cause and effect.
- **Trace to the source** — fix where the problem originates, not where it manifests.
- **Back out failed attempts** — don't layer fix on top of fix. Each attempt starts clean.
- **Consult when uncertain** — if there's ambiguity about cause, intent, or approach, present findings before fixing. Autonomous fixes are for clear-cut cases only.
- **Always recap** — after fixing, summarize root cause, fix, and verification. No silent fixes.
