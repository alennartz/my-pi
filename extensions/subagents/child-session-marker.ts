/**
 * Marker for subagent child session managers.
 *
 * In-process child sessions load the same extensions the root session does, so
 * an extension that must stay silent in children (or behave differently at the
 * root) needs one authoritative answer to "is this session a subagent child?".
 * The subagents extension owns that knowledge and marks the child's
 * SessionManager at construction time; other extensions query it here.
 *
 * The registry is process-global (children are in-process SDK sessions) and is
 * deliberately not persisted: a session restored through
 * `createManagedChildSession` is re-marked on restore.
 */

const REGISTRY_KEY = Symbol.for("my-pi/subagents/child-session-managers");

function getRegistry(): WeakSet<object> {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[REGISTRY_KEY];
	if (existing instanceof WeakSet) return existing as WeakSet<object>;
	const created = new WeakSet<object>();
	globals[REGISTRY_KEY] = created;
	return created;
}

/** Mark a session manager as hosting a subagent child session. */
export function markSubagentChildSession(sessionManager: object): void {
	getRegistry().add(sessionManager);
}

/** Whether this session manager hosts a subagent child session. */
export function isSubagentChildSession(sessionManager: object): boolean {
	return getRegistry().has(sessionManager);
}
