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
export function resolveExplicitAwait(
  requested: readonly AgentPath[],
  stored: readonly StoredChildSettlement[],
): ExplicitAwaitResult {
  const byPath = new Map(stored.map((settlement) => [JSON.stringify(settlement.path), settlement]));
  const statuses: StoredChildSettlement[] = [];
  const pending: AgentPath[] = [];
  for (const path of requested) {
    const settlement = byPath.get(JSON.stringify(path));
    if (settlement) statuses.push(settlement);
    else pending.push(path);
  }
  return { statuses, pending };
}
