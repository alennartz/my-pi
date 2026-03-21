# DR-016: Extension-Level Agent Discovery via Resource Metadata

## Status
Accepted

## Context
When adding distributable agent definitions to pi packages, there were two approaches: make agents a first-class pi-core resource type (like skills, extensions, prompts, themes) so they participate in `resolve()` natively, or keep discovery entirely within the subagents extension by piggy-backing on the package manager's existing resource metadata to locate package root directories.

## Decision
Agent discovery stays at the extension level. The subagents extension instantiates `SettingsManager` + `DefaultPackageManager`, calls `resolve()`, collects unique `baseDir` values from resolved resource metadata (extensions, skills, prompts, themes), then reads `pi.agents` from each discovered package's manifest. This avoids upstream pi-core changes for a feature only relevant when the subagents extension is active.

The alternative — proposing agents as a first-class pi-core resource type — was rejected because it couples a pi-core release to subagent-specific functionality. The subagents extension is the only consumer of agent definitions; adding a resource type that pi-core resolves but never uses creates maintenance surface for no benefit.

## Consequences
Packages that declare only `pi.agents` (no extensions, skills, prompts, or themes) are silently invisible, because their `baseDir` never appears in resource metadata. This is a known limitation inherent to the approach. A future fix would require either a pi-core change to add agents as a resolved resource type, or direct enumeration of installed package directories independent of resource metadata. For now, any package distributing agents must also declare at least one other pi resource type.
