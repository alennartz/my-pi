# resume-restore

Drives the **subagent resume-restore journey** against a real `pi --mode rpc`
process and asserts that restored subagent status is faithful after a parent
session resume.

## Purpose

Exercises the cross-restart path that a single in-process parent cannot drive:
spawn a subagent, let it idle, kill the parent, then **resume** the parent and
verify the restored agent shows correct status — `state: idle` (not stuck
`running`), and usage/cost/turns/model/lastOutput recomputed from the child's
own session file (`parseSessionSnapshot` + the `agent-set.ts` restore seeding),
plus the `hasSubgroup` recompute input (`childHasLiveSubagents`).

## Invocation

```bash
node tools/manual-test/resume-restore/run.mjs [flags]
```

Flags:
- `--workdir <dir>` — scratch dir (default: fresh `mkdtemp` under `$TMPDIR`).
- `--model <id>` — model for parent + worker (default: pi's configured default).
- `--nested` — worker also spawns its own subagent, so the restored worker has a
  non-empty subgroup log (exercises the `hasSubgroup` recompute input).
- `--keep` — do not delete the scratch dir on exit (for debugging).
- `--timeout <sec>` — per-phase timeout (default 240).
- env `RR_VERBOSE=1` — log the resumed model's messages/tool calls to stderr.

## Inputs / Outputs

- **Input:** none required; uses the ambient pi provider config.
- **Output:** a phase log on stderr; a JSON verdict on stdout
  (`{ verdict, nested, checks, observed, expected }`). Exit 0 = PASS, 1 = FAIL.
  Each check compares the restored `check_status` detail against an independent
  re-parse ("oracle") of the worker's session file.

## How it works

1. **Spawn:** launches a parent pi (rpc), prompts it to spawn a `worker`
   subagent that does a trivial task and idles, polls the persistence log until
   the worker session has a completed assistant turn, then kills the parent.
2. **Resume:** relaunches with `--session <parentSessionFile>` and
   `--tools check_status`. The resumed parent **auto-resumes a turn** to continue
   its original task; the tool restriction guarantees that turn cannot mutate the
   restored agent (e.g. `teardown`) before observation. Once the agent is idle,
   the harness drives a `check_status` turn and parses the restored detail.
3. **Assert:** state idle, recomputed usage/model/output/turns equal the oracle,
   cost > 0, and the subgroup input matches `--nested`.

## Prerequisites / Gotchas

- `pi` on PATH with this repo loaded as a package (automatic when `alenna-pi` is
  the active pi package).
- **Scrubs `PI_PARENT_LINK` / `PI_CODING_AGENT`** from the spawned pi env. If run
  from inside a pi subagent, those vars are inherited and would make the test pi
  treat itself as a child (`parentLink`) and skip restore entirely. The harness
  handles this; don't re-introduce the env vars.

## Limitations

- The restored-status surface observed here is `check_status`. The widget/panel
  card rendering of `hasSubgroup` is a TUI component factory that RPC mode
  ignores, so the boolean flag's *rendering* is not directly observed — only its
  recompute *input* (the worker's own `agents.jsonl`) is verified end-to-end.
- Drives a real LLM, so it incurs model cost and tolerates transient latency via
  idle-boundary re-drives.
