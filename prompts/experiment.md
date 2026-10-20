---
description: Run a goal-driven experiment campaign — design a candidate queue up front, then work it one rigorous single-variable A/B experiment at a time (baseline, keep-or-revert, living log) until the goal is reached or the queue is exhausted
argument-hint: "<goal> [in area]"
---
Work toward this goal: $ARGUMENTS

The unit of work is one experiment — one variable, measured honestly — but you never run just one. Design a queue of candidates up front, then work through it one experiment at a time, maintaining the log and the queue as you go, until the goal is reached or the queue is exhausted.

## 1. Frame the goal

- Restate it as measurable metrics (e.g. "generation t/s at 1k/4k prompt tokens", "aggregate tok/s at 16 concurrent streams") plus hard constraints that must not regress (required capabilities, memory budget, quality).
- If the mechanism landscape is not already understood, research first: docs, source, `tools/web_search.py`.

## 2. Design the candidate queue

In the repo's experiment log (`EXPERIMENTS.md`, or the existing domain log such as `PERFORMANCE_EXPERIMENTS.md` — create it if missing), record BEFORE touching anything:

- Goal, metrics, win thresholds, veto conditions, and the exact benchmark command(s), including seed/restart/noise-floor conventions
- Reference measurements of the current configuration — the baseline every trial compares against
- A queue table: ID, candidate, affected metric, the one-at-a-time change, expected mechanism, status

Every candidate must be a single-variable change (one flag, one env var, one file edit, one dependency bump). Order by expected gain vs. cost, and note interactions ("test combination only after E001/E002").

## 3. Experiment loop — repeat for every candidate

Take the highest-value candidate and run, strictly:

1. **Ground the idea.** If its mechanism is not understood, research it. State the hypothesis in one sentence: *changing X should move Y because Z*.
2. **Define success before starting.** The metric and how it is measured (exact command), the threshold that counts as a win (e.g. ≥5% improvement, consistent across test points), and what regression or side-effect would veto the win.
3. **Log before touching.** Confirm the trial's hypothesis, metric, threshold, and change are recorded in the log.
4. **Capture a baseline.** Working tree clean, system in its reference configuration. Measure with the exact command; store raw output outside the repo (e.g. `/tmp`). If a number sits near the noise floor, repeat it to estimate variance first.
5. **Change one thing.** Verify the change is actually active in the running system — check version output, logs, or effective config; a silently cached/no-op change invalidates the trial.
6. **A/B under identical conditions.** Same seed/data/files; restart services between runs if state carries over; no competing load. Normalize per unit, compare like-for-like, and watch for confounds that fake a win (cached state, warmed caches, changed inputs).
7. **Decide against the pre-stated criterion.** Near the threshold, repeat the pair once. A win that only shows up at some test points, or that trades one metric against another, is not a win.
8. **Act.**
   - **Win:** leave the change in place, commit it with a message naming the experiment and measured gain, record result + rollback path in the log, and refresh the reference baseline — all later trials compare against the new baseline.
   - **Lose:** revert completely, re-verify the reference state (config diff empty, service healthy), record the measured numbers and why it lost. Commit only the log update.
   - **Fails to run** (crash, invalid config): that is a result too — document as rejected with the error and restore the reference state.
9. **Update the queue and loop.** Set the candidate's status; add candidates the trial revealed; re-prioritize what remains; take the next one and go to step 1. Non-winners are reverted immediately; each kept change redefines the reference.

## 4. Know when to stop

Stop when the goal is met, the queue is exhausted (every row rejected or deferred with a reason), or a full pass adds nothing above the noise floor. Do not re-roll rejected ideas without a new mechanism-level reason; defer low-expected-value candidates instead of testing them for thoroughness.

## 5. Report

Finish with: the goal and final metrics versus the original baseline, kept changes with commit hashes, rejected candidates with the numbers that killed them, the current state of the system, and the follow-up queue for a future campaign.
