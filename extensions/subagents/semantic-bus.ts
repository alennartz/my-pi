import type { SubagentSemanticFact, SubagentSemanticFactBus } from "./provider.js";

/** Root-scoped semantic fact transport shared by every nested manager. */
export type SemanticFactBus = SubagentSemanticFactBus;

/** In-memory fact bus. It owns subscribers, not semantic history. */
export function createSemanticFactBus(): SemanticFactBus {
	const listeners = new Set<(fact: SubagentSemanticFact) => void>();
	return {
		publish(fact) {
			for (const listener of Array.from(listeners)) {
				try {
					listener(fact);
				} catch {
					// One observer cannot interrupt the manager lifecycle.
				}
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
