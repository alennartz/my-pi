# Code review (round 2): pi 0.64.0 → 0.74.0 upgrade

Scope: uncommitted changes after the first reviewer's S1 finding was acted on (early-return on `reload` was removed; explanatory comment added). Authority order: installed `.d.ts` > pi docs > examples > changelog. The author's `docs/plans/pi-upgrade*.md` are not consulted for correctness.

---

## 🟡 S1-followup — comment on `session_shutdown` overstates what the handler does

**File:** `extensions/subagents/index.ts:1259-1284`

The reverted handler now reads:

```ts
pi.on("session_shutdown", async () => {
  // ...explanatory comment about why we always tear down...
  queue.clear();
  if (manager) {
    const broker = manager.getBroker();
    if (broker) {
      await broker.stop();
    }
    manager = null;
  }
  // ...disconnects parentBrokerClient / brokerClient; nulls dashboard, tui, panel...
});
```

The comment claims the handler tears down so children don't leak across `/reload`. The code only stops the **broker** (`broker.stop()`); it never calls `manager.teardown()` and never iterates the RPC children to `rpc.stop()` them. Compare `agent-set.ts:374` (`teardownAll` does `await Promise.all(this.entries.map((e) => e.rpc.stop()))` *before* `broker.stop()`) — that's the only path in the codebase that actually sends SIGTERM to spawned `pi` child processes.

Consequences:
- `broker.stop()` (`broker.ts:60-80`) closes broker socket connections and `unlink`s the socket file, but it does not signal the children.
- The children's only remaining lifeline is their stdin pipe to the host pi process. They aren't killed; they may persist until the parent pi process exits (closing their stdin) or until the `ChildProcess` object inside the dead module instance is GC'd. Neither is guaranteed promptly on `/reload`.

This is **pre-existing behavior** — the diff did not introduce it; it only added a comment that overstates the cleanliness of the teardown. But the first review's "S1 revert is the fix" framing implies session_shutdown does a full teardown, which it doesn't. If `/reload` with live subagents really does spawn duplicate children (because old ones aren't reliably killed and new ones come up via `restoreFromPersistence`), the leak the first reviewer described isn't fully resolved — it's just smaller and racier.

**Verification needed (not done in this review):** run pi with one live subagent, `/reload`, then `ps -ef | grep "pi --mode rpc"` and count. If you see N children before and 2N after, the comment is wrong and the handler still needs `await manager.teardown()` (or equivalent) instead of just `broker.stop()`.

**Evidence:**
- `extensions/subagents/agent-set.ts:362-382` (`teardownAll` does children+broker; this is the only proper teardown path).
- `extensions/subagents/broker.ts:60-80` (`broker.stop()` only closes broker server + sockets).
- `extensions/subagents/rpc-child.ts:182-205` (`rpc.stop()` is what actually sends SIGTERM).
- `extensions/subagents/rpc-child.ts:52-58` (children are non-detached `spawn("pi", …, {stdio:["pipe","pipe","pipe"]})` — they survive a broker socket close).

---

## 🟡 P1 — stale `@mariozechner/*` packages installed under `node_modules/`

**File:** `package-lock.json:1652-1750` (and resolved files in `node_modules/@mariozechner/`).

After `npm install`, both `@earendil-works/pi-coding-agent@0.74.0` *and* `@mariozechner/pi-coding-agent@0.64.0` (plus `pi-agent-core`, `pi-ai`, `pi-tui` at 0.64.0) are present on disk:

```
node_modules/@earendil-works/pi-coding-agent   # 0.74.0  (the one extensions actually use)
node_modules/@mariozechner/pi-coding-agent     # 0.64.0  (dead-weight)
```

Tracing the lockfile, the `@mariozechner/*` tree exists because `@pimote/panels@0.1.0` declares `peerDependencies: { "@mariozechner/pi-coding-agent": "^0.64.0" }` (`node_modules/@pimote/panels/package.json:38-41`) and npm 7+ auto-installs peer deps.

Runtime impact: **none.** pi's loader has `@mariozechner/*` aliased to the same in-binary virtual modules as `@earendil-works/*` (see `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js.map`, the `VIRTUAL_MODULES` table re-maps `@mariozechner/pi-{coding-agent,ai,tui,agent-core}` to the same bundled instances). So any code path that does end up reaching for the old scope name is silently redirected to the new bundle. `@pimote/panels` itself only references `@mariozechner/pi-coding-agent` in its `.d.ts` (`node_modules/@pimote/panels/dist/detect.d.ts:1`); its compiled `.js` doesn't import the package at all.

Disk impact: a few MB of duplicated package trees that npm will keep re-installing on every `npm ci`. Cosmetic but not load-bearing. Worth opening a ticket against `@pimote/panels` to update its peerDependency to `@earendil-works/pi-coding-agent`; nothing to fix in this repo.

**Evidence:** `package-lock.json` lines 1652-1750; `node_modules/@pimote/panels/package.json:36-42`; loader's `VIRTUAL_MODULES` aliases.

---

## 🟢 D1 — stale package references in historical investigation docs

**Files:**
- `docs/pi-internals/message-delivery.md:5`
- `docs/investigations/session-auto-resume-cwd-mismatch.md:3,47-48`

Still reference `@mariozechner/pi-coding-agent`. Both files self-identify as version-pinned investigations (`v0.61.1`, `0.66.1`). They are historical write-ups, not living docs — the references describe what the package was called at the time of writing. Probably fine to leave, but if you want a clean repo-wide grep for the old scope name to come back empty, sweep these too. `codemap.md`, `README.md`, and `AGENTS.md` are clean.

---

## 🟢 A1-followup — `FRIENDLY_NAMES` placement

**File:** `extensions/azure-foundry/index.ts:379-384`

`FRIENDLY_NAMES` is declared inside `export default function (pi)`, which runs **once** when pi loads the extension (and once again per `/reload`). It is *not* reconstructed per provider-registration cycle or per `discoverDeployments` call — there is exactly one `discoverDeployments()` call at the top of the entry function (line 367). So the "is this rebuilt every discovery cycle" concern in the review brief is moot; it's a constant.

`ProviderConfig.name` is typed `name?: string` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:941`) and is consumed by `ModelRegistry.getProviderDisplayName` (`model-registry.js:572-580`), which falls back through `registeredProvider.name` → `oauth.name` → built-in defaults → raw provider id. That helper is read by:

- `interactive-mode.js:3640, 3657` (`/login` API-key flow), so `name` *will* surface for azure-foundry since it's API-key-authenticated.
- `oauth-selector.js:63, 82, 86` (OAuth login flow) — irrelevant for azure-foundry, but confirms the field is hooked up.

✅ Friendly name change is safe and effective. Nothing to fix.

---

## ✅ Spot-checks that came back clean

- **S2 skip-restore semantics.** `extensions/subagents/index.ts:357-363` returns on `event.reason === "new"|"fork"` *before* `ensureManager` / `ensureWidget`. Persistence is keyed by parent `sessionFile` (`agent-set.ts:138-142`, `persistence.ts` paths derive from it). On `/new` and `/fork`, pi gives the new session a different `sessionFile`, so `loadPersistedAgents` would no-op anyway — the early-return is a redundant-but-correct optimization. No state needed to be reset that the skipped path was doing: `cachedPackageAgents` is repopulated at the top of the handler before the early-return, and all other state (`manager`, `parentBrokerClient`, `dashboard`, `tuiRef`, `panelHandle`) is freshly null in the new module instance after `/reload`. For non-reload `new`/`fork`, the old module instance lives on (this is the same pi process, just a new session), but the `session_shutdown` handler nulled all of them before this fires. ✓
- **`reload` is correctly *not* skipped.** S2 only skips on `new`/`fork`, so on `/reload` (which keeps the same parent session file — verified in design context against `agent-set.ts:138`), persistence restore runs and reattaches widgets/broker. Correct behavior given the documented design intent. ✓
- **W1 dead-code.** The hand-rolled `loadSessionManager()` + `getPackageResolutionPaths()` + `cachedSessionManager` are fully excised (`extensions/worktree/index.ts` diff). `existsSync` import is gone in the working tree (first review's nit was acted on). No other lingering references to the old resolution machinery elsewhere in `worktree/`. ✓
- **W1 consumer of `continueRecent`.** `extensions/worktree/controller.ts:30` does `(await sessions.continueRecent(worktreePath)) ?? sessions.create(worktreePath)` — handles `undefined` by falling back to `create`. So the optional-chain in `index.ts:229` is defensive and the downstream consumer is prepared. ✓
- **TypeBox schemas.** Every schema in this repo uses only `Type.Object`, `Type.String`, `Type.Array`, `Type.Optional`, `Type.Boolean`, `Type.Integer`, `Type.Record` (verified via grep). No `Type.Union`, `Type.Pick`, `Type.Omit`, `Type.Composite`, `Type.Intersect`, or discriminated-union builders — i.e., none of the typebox 0.34→1.x churn surfaces are touched. All used factories are present in `node_modules/typebox/build/typebox.d.mts`. ✓
- **Loader virtual-module mapping.** pi's extension loader aliases both `@earendil-works/*` *and* `@mariozechner/*` to the same bundled internals (`loader.js.map` `VIRTUAL_MODULES`/`getAliases`). So the rename was strictly cosmetic for runtime; even partial renames would have worked. The full rename is good hygiene. ✓
- **No module-level mutable state in `subagents/index.ts`.** Only `const USE_STEER_DELIVERY`, `STATE_COLORS`, `STATE_LABELS`. All `let` state lives inside `default function (pi)`'s closure, recreated fresh on `/reload`. ✓
- **`package.json` peerDependency** correctly renamed (`package.json:30`). `package-lock.json` resolves `@earendil-works/pi-coding-agent@0.74.0` matching `pi --version` of 0.74.0. ✓
- **`SessionStartEvent.reason` enum** has exactly the 5 values the S2 logic switches on: `"startup" | "reload" | "new" | "resume" | "fork"` (`types.d.ts:385`). No missed cases. ✓
- **No remaining `@mariozechner` or `@sinclair/typebox` references** in `extensions/`, `lib/`, `scripts/`, `skills/`, `agents/`, `AGENTS.md`, `codemap.md`, `README.md`. ✓ (lockfile entries and the two historical investigation docs noted above are the only hits.)

---

## Things the first review missed

1. **The "always tear down" comment claims something the handler doesn't fully do** (S1-followup above). The first review framed the revert as "the fix"; it removes the early-return but doesn't address the fact that even the standard `session_shutdown` path leaks RPC children, because the handler only calls `broker.stop()` and never `rpc.stop()` or `manager.teardown()`. This is pre-existing, but it's relevant to the design claim ("subagents survive `/reload`" because shutdown is clean + start re-spawns) — shutdown isn't actually clean.
2. **Stale `@mariozechner/*` tree on disk** (P1 above). Not a runtime issue thanks to pi's loader aliasing, but the lockfile and node_modules both still carry the old scope at 0.64.0. The first review's package-rename verification looked only at the new-scope additions, not at whether the old ones got pruned.
3. **`FRIENDLY_NAMES` is one-shot per extension load** — the brief asked whether it's reconstructed every cycle; it isn't. Worth confirming on the record (A1-followup above).
4. **Historical docs grep** (D1 above) — minor.

---

## Verdict

**Merge.**

The package rename, W1 refactor, A1 friendly-name addition, S2 skip-restore, and TypeBox swap are all sound. The S1 revert is in place.

The two 🟡 items are both pre-existing (P1 is upstream of this repo entirely; the S1-followup is a long-standing rough edge in the shutdown handler whose effect is *bounded* by the same loader aliasing that bounds P1). Neither blocks the upgrade. If the author cares about the `/reload` claim being literally true, follow up by replacing `broker.stop()` with `await manager.teardown()` in the shutdown handler and re-verify with `ps`.
