import type { AgentPath } from "./agent-path.js";
import type { FeedCursor, PiEventRef, SubagentEvent, SubagentEventKind } from "./provider.js";

/** Input accepted by the semantic-event provenance seam. */
export type SemanticEventInput = Readonly<{
	eventId: string;
	cursor: FeedCursor;
	path: AgentPath;
	kind: SubagentEventKind;
	relatedPiEvents: readonly PiEventRef[];
	data: unknown;
}>;

/**
 * Build one semantic overlay while retaining every supplied native Pi reference.
 * The native transcript remains authoritative for replay and fallback rendering.
 */
export function createSemanticEvent(_input: SemanticEventInput): SubagentEvent {
	throw new Error("not implemented");
}
