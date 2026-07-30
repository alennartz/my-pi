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

/** Remove one session-manager association without destroying the shared store. */
export function unregisterSessionTreeStore(sessionManager: object, store?: SessionTreeStore): void {
	const registry = getRegistry();
	if (store !== undefined && registry.get(sessionManager) !== store) return;
	registry.delete(sessionManager);
}
