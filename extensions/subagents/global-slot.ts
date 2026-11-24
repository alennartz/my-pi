/**
 * Process-global slots shared by independently loaded copies of a module.
 *
 * Each slot holds one lookup keyed by session-manager identity. The accessors
 * here read and publish the slot without asserting a shape the runtime cannot
 * prove; the caller narrows through `isKeyedLookup`.
 */

/** A keyed lookup: the shape every shared registry provides. */
export type KeyedLookup<K, V> = {
	get(key: K): V | undefined;
	set(key: K, value: V): void;
	has(key: K): boolean;
	delete(key: K): boolean;
};

/** Whether a value behaves as a keyed lookup. */
export function isKeyedLookup<K, V>(value: unknown): value is KeyedLookup<K, V> {
	if (value === null || typeof value !== "object") {return false;}
	if (!("get" in value) || !("set" in value) || !("has" in value) || !("delete" in value)) {return false;}
	return typeof value.get === "function" && typeof value.set === "function"
		&& typeof value.has === "function" && typeof value.delete === "function";
}

/** Read one process-global slot, or undefined when nothing published it. */
export function readGlobalSlot(key: symbol): object | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
	const value: unknown = descriptor?.value;
	return typeof value === "object" && value !== null ? value : undefined;
}

/** Publish one process-global slot. */
export function writeGlobalSlot(key: symbol, value: KeyedLookup<never, unknown>): void {
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: false });
}
