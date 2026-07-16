/** Canonical root-relative identity for a live agent node. */
export type AgentPath = readonly string[];

/** Append one sibling-scoped local ID to a canonical parent path. */
export function childAgentPath(parent: AgentPath, localId: string): AgentPath {
	return [...parent, localId];
}

/** Escape path segments and format a canonical path for display/session naming. */
export function formatAgentPath(path: AgentPath): string {
	return path.map((segment) => encodeURIComponent(segment) || "%").join("/");
}
