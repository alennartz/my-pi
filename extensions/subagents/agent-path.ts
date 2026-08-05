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

/**
 * Display identity of a descendant relative to an owning ancestor: the local
 * ID for an immediate child, a slash-joined trail for anything deeper. Returns
 * an empty string when `path` is not below `owner`, so callers keep whatever
 * fallback identity they already have.
 */
export function qualifiedAgentId(owner: AgentPath, path: AgentPath): string {
	if (path.length <= owner.length) return "";
	if (!owner.every((segment, index) => segment === path[index])) return "";
	return path.slice(owner.length).join("/");
}
