/** Canonical root-relative identity for a live agent node. */
export type AgentPath = readonly string[];

/** Append one sibling-scoped local ID to a canonical parent path. */
export function childAgentPath(_parent: AgentPath, _localId: string): AgentPath {
	throw new Error("not implemented");
}

/** Escape path segments and format a canonical path for display/session naming. */
export function formatAgentPath(_path: AgentPath): string {
	throw new Error("not implemented");
}
