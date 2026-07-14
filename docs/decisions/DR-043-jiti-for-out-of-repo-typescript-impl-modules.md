# DR-043: jiti used to load out-of-repo TypeScript implementation modules

## Status
Accepted

## Context
Out-of-repo provider implementations live at user-configured paths and need to be TypeScript — the typed-seam design goal requires it. The quota-providers extension and `runner.mjs` must load them at runtime without requiring a build step from the user.

## Decision
`jiti` (upstream, not pi's fork `@mariozechner/jiti`) is declared as an explicit dependency and used via `createJiti(import.meta.url)` to load implementation modules. This lets impl authors write TypeScript at arbitrary filesystem paths without a compiler or build configuration.

Alternatives rejected:
- **Native `import()`**: zero deps, but impl modules must be plain JS/ESM — loses the TypeScript typed-seam goal.
- **Rely on pi's loader intercepting dynamic `import()` in extensions**: undocumented pi internals that could change between versions.

jiti is the same mechanism pi itself uses to load extensions, is already present transitively, and makes TS impls work at arbitrary paths regardless of pi's loader internals.

## Consequences
`jiti` is an explicit `dependencies` entry in the root `package.json`. Out-of-repo impl modules are loaded via jiti's transform pipeline and must be compatible with jiti's TypeScript handling — standard TypeScript works; exotic decorators or bundler-specific syntax may not. `runner.mjs` (plain Node, cannot import TypeScript) duplicates the reserved policy-key list from `lib/config.ts` to strip them from `ImplContext.settings`.
