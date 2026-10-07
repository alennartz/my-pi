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

/**
 * Persona payload from a named agent definition, recorded on the child's
 * session manager at spawn time so extensions can see which specialist body
 * the orchestrator deployed (deliberately not persisted — a restored or
 * re-resurrected child is re-marked with a re-resolved payload).
 */
export type PersonaPayload = { name: string; body: string };

/**
 * Mark a session manager as hosting a subagent child session, optionally
 * recording the spawn-declared persona payload.
 */
export function markSubagentChildSession(sessionManager: object, payload?: PersonaPayload): void {
	getRegistry().add(sessionManager);
}

/**
 * Return the persona payload the spawn path recorded for this child session,
 * if any. Undefined outside subagent children and for children spawned
 * without a named agent definition.
 */
export function getSubagentPersona(sessionManager: object): PersonaPayload | undefined {
	throw new Error("not implemented");
}

/** Whether this session manager hosts a subagent child session. */
export function isSubagentChildSession(sessionManager: object): boolean {
	return getRegistry().has(sessionManager);
}
