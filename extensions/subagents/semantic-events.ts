import type { SubagentEvent, SubagentSemanticFact } from "./provider.js";

/**
 * Inputs accepted by the semantic-event seam.
 *
 * A live fact has no provider cursor. The provider adds that cursor when it
 * accepts the fact into its ordered feed. Persisted or already-fed events can
 * include the cursor and pass through the same constructor.
 */
export type SemanticEventInput = SubagentSemanticFact | SubagentEvent;

/**
 * Clone one semantic value without interpreting or truncating its payload.
 * Semantic data is JSON-shaped, but keeping non-plain values by reference
 * preserves extension metadata that the native transcript already owns.
 */
function cloneSemanticValue<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => cloneSemanticValue(item))) as T;
	}
	if (value && typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return value;
		const copy: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			copy[key] = cloneSemanticValue(child);
		}
		return Object.freeze(copy) as T;
	}
	return value;
}

/**
 * Build one immutable semantic event while retaining every supplied native Pi
 * reference for persistence and hydration.
 *
 * This constructor is deliberately a pure boundary. It does not derive local
 * ids, collapse paths, rewrite metadata, or apply model-output truncation.
 * Callers pass root-relative paths and complete data; native provenance and
 * structured details therefore survive unchanged.
 */
export function createSemanticEvent<T extends SemanticEventInput>(input: T): T {
	return cloneSemanticValue(input);
}
