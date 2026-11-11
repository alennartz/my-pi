import type { SubagentEvent } from "./provider.js";

/** Input accepted by the semantic-event provenance seam. */
export type SemanticEventInput = SubagentEvent;

/**
 * Build one semantic overlay while retaining every supplied native Pi reference.
 * The native transcript remains authoritative for replay and fallback rendering.
 */
export function createSemanticEvent(_input: SemanticEventInput): SubagentEvent {
	throw new Error("not implemented");
}
