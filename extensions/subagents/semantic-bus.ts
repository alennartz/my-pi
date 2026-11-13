import type { SemanticAdapterEvent } from './semantic-adapter.js';
import type { SubagentSemanticFact, SubagentSemanticFactBus } from './provider.js';

/** Private typed facts shared by nested managers and the provider adapter. */
export type SemanticPresentationEvent = SemanticAdapterEvent;

/** Root-scoped semantic fact transport shared by every nested manager. */
export type SemanticFactBus = SubagentSemanticFactBus & {
  /** Private presentation channel. It never crosses the SDK/provider boundary directly. */
  publishPresentation?(event: SemanticPresentationEvent): void;
  subscribePresentation?(listener: (event: SemanticPresentationEvent) => void): () => void;
};

/** In-memory fact bus. It owns subscribers, not semantic history. */
export function createSemanticFactBus(): SemanticFactBus {
  const listeners = new Set<(fact: SubagentSemanticFact) => void>();
  const presentationListeners = new Set<(event: SemanticPresentationEvent) => void>();
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
    publishPresentation(event) {
      for (const listener of Array.from(presentationListeners)) {
        try {
          listener(event);
        } catch {
          // Presentation observers cannot interrupt the native operation.
        }
      }
    },
    subscribePresentation(listener) {
      presentationListeners.add(listener);
      return () => presentationListeners.delete(listener);
    },
  };
}
