/**
 * Process-global slot shared by independently loaded copies of a module.
 *
 * `Symbol.for` keys survive `/reload`: the reloaded module instance reads the
 * same slot on globalThis instead of building fresh state. The value is
 * validated through a structural guard, so a foreign or stale occupant is
 * replaced rather than trusted.
 */
export class GlobalSlot<T> {
	readonly #key: symbol;
	readonly #isValid: (value: unknown) => value is T;
	readonly #create: () => T;

	constructor(key: string, isValid: (value: unknown) => value is T, create: () => T) {
		this.#key = Symbol.for(key);
		this.#isValid = isValid;
		this.#create = create;
	}

	/** Read the slot's occupant, creating and publishing one when absent or stale. */
	value(): T {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, this.#key);
		const occupant: unknown = descriptor?.value;
		if (this.#isValid(occupant)) {return occupant;}
		const created = this.#create();
		Object.defineProperty(globalThis, this.#key, {
			value: created,
			configurable: true,
			writable: true,
			enumerable: false,
		});
		return created;
	}
}

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
