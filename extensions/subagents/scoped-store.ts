/**
 * Small key/value store owned by one subagent tree.
 *
 * The store itself belongs to AgentSessionRegistry. The WeakMap below only
 * connects SDK SessionManager instances to that store so independently loaded
 * extensions can retrieve the tree-local state for their current session.
 * Nothing is persisted and the WeakMap does not keep session managers alive.
 */

import type { SessionTreeStore } from "../../lib/session-tree-store.js";

class InMemorySessionTreeStore implements SessionTreeStore {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	set<T>(key: string, value: T): void {
		this.values.set(key, value);
	}

	delete(key: string): void {
		this.values.delete(key);
	}

	clear(): void {
		this.values.clear();
	}
}

type StoreRegistry = WeakMap<object, SessionTreeStore>;
const REGISTRY_KEY = Symbol.for("my-pi/subagents/session-tree-stores");

function getRegistry(): StoreRegistry {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[REGISTRY_KEY];
	if (existing instanceof WeakMap) return existing as StoreRegistry;
	const created: StoreRegistry = new WeakMap();
	globals[REGISTRY_KEY] = created;
	return created;
}

/** Create a fresh tree store for a new root registry. */
export function createSessionTreeStore(): SessionTreeStore {
	return new InMemorySessionTreeStore();
}

/** Retrieve the store already associated with a session manager. */
export function getSessionTreeStore(sessionManager: object): SessionTreeStore | undefined {
	return getRegistry().get(sessionManager);
}

/** Retrieve or lazily create the store for a session manager. */
export function getOrCreateSessionTreeStore(sessionManager: object): SessionTreeStore {
	const registry = getRegistry();
	const existing = registry.get(sessionManager);
	if (existing) return existing;
	const created = createSessionTreeStore();
	registry.set(sessionManager, created);
	return created;
}

/** Associate a child session manager with its parent's tree store. */
export function registerSessionTreeStore(sessionManager: object, store: SessionTreeStore): void {
	getRegistry().set(sessionManager, store);
}

/**
 * Session-id index for callers that see only a request's session id (e.g. the
 * provider boundary, where `options.sessionId` is the only identity). Same
 * values as the manager registry, second key space. Strongly held; entries are
 * removed via unregisterSessionIdTreeStore when the session shuts down.
 */
type IdRegistry = Map<string, SessionTreeStore>;
const ID_REGISTRY_KEY = Symbol.for("my-pi/subagents/session-id-tree-stores");

function getIdRegistry(): IdRegistry {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[ID_REGISTRY_KEY];
	if (existing instanceof Map) return existing as IdRegistry;
	const created: IdRegistry = new Map();
	globals[ID_REGISTRY_KEY] = created;
	return created;
}

/** Retrieve the store registered for a session id, if any. */
export function getSessionIdTreeStore(sessionId: string): SessionTreeStore | undefined {
	return getIdRegistry().get(sessionId);
}

/** Index a tree store under a session id so request-level callers can resolve it. */
export function registerSessionIdTreeStore(sessionId: string, store: SessionTreeStore): void {
	getIdRegistry().set(sessionId, store);
}

/** Remove one session-id association without destroying the shared store. */
export function unregisterSessionIdTreeStore(sessionId: string, store?: SessionTreeStore): void {
	const registry = getIdRegistry();
	if (store !== undefined && registry.get(sessionId) !== store) return;
	registry.delete(sessionId);
}

/** Remove one session-manager association without destroying the shared store. */
export function unregisterSessionTreeStore(sessionManager: object, store?: SessionTreeStore): void {
	const registry = getRegistry();
	if (store !== undefined && registry.get(sessionManager) !== store) return;
	registry.delete(sessionManager);
}
