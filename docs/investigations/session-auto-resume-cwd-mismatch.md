# Investigation: two session cwd bugs (`create() + switchSession()` and auto-resume)

Version: `@mariozechner/pi-coding-agent 0.66.1`

## Summary

There are **two distinct cwd bugs** here, with similar symptoms but different triggers and causes.

### Bug 1: immediate switch to a newly created session can use the wrong cwd

If an extension does this:

```ts
const session = SessionManager.create(targetCwd, sessionDir);
await ctx.switchSession(session.getSessionFile()!);
```

then pi can switch into a **clean new session** while still using the **current launch/runtime cwd** instead of `targetCwd`.

Observed behavior:
- the session is fresh/empty
- UI still shows cwd **A**
- system prompt says `Current working directory: A`
- intended target cwd was **B**

This happens because `SessionManager.create(...)` allocates a session path immediately, but the file is not necessarily written to disk yet. `ctx.switchSession(...)` reopens by path, and `SessionManager.open(...)` falls back to `process.cwd()` if it cannot read a session header from disk.

### Bug 2: startup auto-resume can reopen the right session file with the wrong cwd

If pi starts in cwd **A** and auto-resumes an **existing persisted** session file whose header cwd is **B**, the live session can still use **A** instead of **B**.

Observed behavior:
- UI shows cwd **A**
- system prompt says `Current working directory: A`
- resumed session header still says cwd **B**

This happens on startup auto-resume. It is the behavior observed with the richer worktree extension when using a **forked** session path rather than a fresh session path.

## Repro extension

Save this extension as `extensions/repro-resume-cwd/index.ts`:

```ts
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

export default function reproResumeCwd(pi: ExtensionAPI) {
	pi.registerCommand("repro-resume-cwd", {
		description: "Create a session in another cwd and switch to it",
		handler: async (args, ctx) => {
			const targetCwd = join(tmpdir(), "pi-repro-resume-cwd", args.trim() || "resume-cwd-target");
			mkdirSync(targetCwd, { recursive: true });
			await ctx.switchSession(SessionManager.create(targetCwd, ctx.sessionManager.getSessionDir()).getSessionFile()!);
		},
	});

	pi.registerCommand("repro-resume-cwd-fork", {
		description: "Fork the current session into another cwd and switch to it",
		handler: async (args, ctx) => {
			const targetCwd = join(tmpdir(), "pi-repro-resume-cwd", args.trim() || "resume-cwd-target");
			mkdirSync(targetCwd, { recursive: true });
			await ctx.switchSession(SessionManager.forkFrom(
				ctx.sessionManager.getSessionFile()!,
				targetCwd,
				ctx.sessionManager.getSessionDir(),
			).getSessionFile()!);
		},
	});
}
```

## Repro A: immediate-switch bug (`create() + switchSession()`)

1. Start pi in cwd **A**.
2. Run `/repro-resume-cwd demo`.
3. Ask the agent what the current working directory is.

Expected:
- pi switches into a new session rooted at `/tmp/pi-repro-resume-cwd/demo`
- UI shows `/tmp/pi-repro-resume-cwd/demo`
- system prompt says `Current working directory: /tmp/pi-repro-resume-cwd/demo`

Actual:
- pi switches into a **clean new session**
- UI still shows cwd **A**
- system prompt says `Current working directory: A`

## Repro B: auto-resume bug (`forkFrom()` + `--continue`)

1. Start pi in cwd **A**.
2. Send a normal message and wait for the assistant response so the current session is actually persisted.
3. Run `/repro-resume-cwd-fork demo`.

(That command is intentionally minimal; it assumes `ctx.sessionManager.getSessionFile()` already points at a real persisted file.)
4. Confirm pi now behaves as if cwd is `/tmp/pi-repro-resume-cwd/demo`.
5. Exit pi.
6. Reopen pi in cwd **A** with `pi --continue`.
7. Ask the agent what the current working directory is as reported by the system prompt vs. bash tools.

Expected:
- UI shows `/tmp/pi-repro-resume-cwd/demo`
- system prompt says `Current working directory: /tmp/pi-repro-resume-cwd/demo`

Actual:
- UI shows cwd **A**
- system prompt says `Current working directory: A`
- resumed session header still says `/tmp/pi-repro-resume-cwd/demo`

## Root cause analysis

### Bug 1 root cause: `create()` returns a path before a readable session file exists

`SessionManager.create(...)` creates a manager with header cwd **B**, but the corresponding session file is not immediately written to disk. Persistence is deferred until there is assistant output.

`ctx.switchSession(...)` then reopens by file path. `SessionManager.open(...)` derives cwd like this:

```ts
static open(path, sessionDir, cwdOverride) {
  const entries = loadEntriesFromFile(path);
  const header = entries.find((e) => e.type === "session");
  const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
  const dir = sessionDir ?? resolve(path, "..");
  return new SessionManager(cwd, dir, path, true);
}
```

If the file does not exist yet, `loadEntriesFromFile(path)` yields no header, so `open(...)` falls back to `process.cwd()`.

So the immediate-switch bug is specifically:
- target session cwd in memory = **B**
- target session file not yet readable
- reopen falls back to current cwd = **A**

### Bug 2 root cause: `continueRecent()` ignores the session header cwd

`SessionManager.continueRecent(...)` appears to construct an existing recent session with the caller-provided cwd:

```ts
static continueRecent(cwd, sessionDir) {
  const dir = sessionDir ?? getDefaultSessionDir(cwd);
  const mostRecent = findMostRecentSession(dir);
  if (mostRecent) {
    return new SessionManager(cwd, dir, mostRecent, true);
  }
  return new SessionManager(cwd, dir, undefined, true);
}
```

If `cwd` is startup cwd **A**, but the resumed session file header stores **B**, the live session keeps **A**.

So the auto-resume bug is specifically:
- target session file already exists
- its header cwd is **B**
- `continueRecent(...)` still constructs the live manager with **A**

## Important clarification about explicit switching

Earlier analysis treated explicit `switchSession()` as a counterexample for the auto-resume bug. That is only true when the target session file already exists and contains the correct header.

- Explicit `switchSession()` to a **not-yet-flushed created session** triggers **Bug 1**.
- Explicit `switchSession()` to an **existing forked or already-persisted session file** reads the header cwd correctly.
- Startup `--continue` / auto-resume can still trigger **Bug 2** even for those persisted files.

## Proposed fixes

### Fix for Bug 1

When switching to a freshly created session, pi needs either:

1. a way to switch using the already-instantiated `SessionManager` rather than reopening by path, or
2. `SessionManager.create(...)` to materialize a readable session file immediately, or
3. `SessionManager.open(...)` / session switching logic to treat a missing target file as an error instead of silently falling back to `process.cwd()`.

### Fix for Bug 2

When `continueRecent(...)` finds an existing session, reopen it through `SessionManager.open(...)` instead of constructing it with the caller-provided cwd.

Example:

```ts
static continueRecent(cwd, sessionDir) {
  const dir = sessionDir ?? getDefaultSessionDir(cwd);
  const mostRecent = findMostRecentSession(dir);
  if (mostRecent) {
    return SessionManager.open(mostRecent, dir);
  }
  return new SessionManager(cwd, dir, undefined, true);
}
```
