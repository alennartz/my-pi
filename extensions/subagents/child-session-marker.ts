import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { GlobalSlot, isKeyedLookup } from "./global-slot.js";
import type { KeyedLookup } from "./global-slot.js";


/** A session manager identity, usable as a registry key. */
export type SessionManagerRef = Pick<SessionManager, "getCwd">;
/**
 * Marker for subagent child session managers.
 *
 * In-process child sessions load the same extensions the root session does, so
 * an extension that must stay silent in children (or behave differently at the
 * root) needs one authoritative answer to "is this session a subagent child?".
 * The subagents extension owns that knowledge and marks the child's
 * SessionManager at construction time; other extensions query it here.
 *
 * The registry is a process-global WeakMap keyed by the child's SessionManager
 * (children are in-process SDK sessions) and is deliberately not persisted: a
 * session restored through `createManagedChildSession` is re-marked on restore.
 * Key presence answers "is this a child?"; the mapped value carries the
 * spawn-declared persona payload, so a child without a persona stays
 * distinguishable from a root session.
 */

const childSessionRegistrySlot = new GlobalSlot<KeyedLookup<object, PersonaPayload | undefined>>(
	"my-pi/subagents/child-session-managers",
	(value): value is KeyedLookup<object, PersonaPayload | undefined> => isKeyedLookup<object, PersonaPayload | undefined>(value),
	() => new WeakMap<object, PersonaPayload | undefined>(),
);

function getRegistry(): KeyedLookup<object, PersonaPayload | undefined> {
	return childSessionRegistrySlot.value();
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
export function markSubagentChildSession(sessionManager: SessionManagerRef, payload?: PersonaPayload): void {
	getRegistry().set(sessionManager, payload);
}

/**
 * Return the persona payload the spawn path recorded for this child session,
 * if any. Undefined outside subagent children and for children spawned
 * without a named agent definition.
 */
export function getSubagentPersona(sessionManager: SessionManagerRef): PersonaPayload | undefined {
	return getRegistry().get(sessionManager);
}

/** Whether this session manager hosts a subagent child session. */
export function isSubagentChildSession(sessionManager: SessionManagerRef): boolean {
	return getRegistry().has(sessionManager);
}
