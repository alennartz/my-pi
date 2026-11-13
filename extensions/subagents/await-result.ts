import type { AgentPath } from './agent-path.js';

export type StoredChildSettlement = Readonly<{
  path: AgentPath;
  state: 'idle' | 'errored' | 'dead' | 'stopped';
  output?: string;
  error?: string;
  sessionId?: string;
}>;

export type ExplicitAwaitResult = Readonly<{
  statuses: readonly StoredChildSettlement[];
  pending: readonly AgentPath[];
}>;

/** Resolve an explicit await from stored settlement state before starting a wait. */
export function resolveExplicitAwait(_requested: readonly AgentPath[], _stored: readonly StoredChildSettlement[]): ExplicitAwaitResult {
  throw new Error('not implemented');
}
