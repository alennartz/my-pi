# DR-059: Resolve pi host packages from local devDependencies

## Status
Accepted

## Context
Tests need the five host-provided packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`). Two pi runtimes exist on this machine: the pimote bundle and the regular CLI install. `vitest.config.ts` used to alias all five into whichever pimote release directory sorted newest. This coupled the test stack to an install location we do not own. pimote rc.4 moved the runtime one level down (`node_modules/@pimote/pimote/node_modules`), every alias went dead, and 24 test files failed at import with an unrelated-looking `typebox` resolution error.

## Decision
Declare the five host packages as devDependencies. Delete all install-path resolution from `vitest.config.ts` (`hostModules()`, the alias array, and `PI_HOST_MODULES`); standard `node_modules` resolution covers every specifier, including the `pi-ai` subpath exports. Peer entries stay in the manifest at `"*"` per pi's packaging contract: pi installs only `dependencies` on managed installs, suppresses peer installation, and supplies the host packages itself, so neither peers nor devDependencies ship to consumers.

Rejected alternatives:

- **devDependency for `typebox` only.** Fixed one alias; the four `@earendil-works/*` aliases stayed dead. Treated the symptom.
- **Repoint `hostModules()` at the rc.4 nested layout.** Kept the fragile newest-release-directory sniffing and the test/runtime version split. The layout already moved once without notice.
- **Resolve from the regular CLI install path instead of pimote.** Still install-location sniffing, only with a different victim.

## Consequences
Tests run against npm-published pi, pinned by the lockfile, not against a bundled runtime. If a bundled runtime races ahead of npm, tests do not see it until npm catches up. The update-pi prompt keeps its version anchors: devDependency ranges declare intent, the lockfile pins the exact installed versions for changelog diffing, and peer ranges carry no version information by design. A peer range cannot guard against old pi anyway, because pi does not resolve peers on managed install paths; an extension that needs a hard minimum version must check the API at activation and fail with a clear message. Known watch-item: the pi packages transitively bundle a nested `typebox` that can differ from the top-level devDependency, so the test process can hold two copies. Benign today; first suspect if TypeBox symbol-identity issues appear in tests.
