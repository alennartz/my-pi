import { describe, expect, it } from 'vitest';
import type { AgentSessionRegistry, RegistryEvent } from './agent-session-registry.js';
import { createSubagentProvider, type BorrowedAgentSession, type SubagentOwnerControlPort } from './provider.js';
import type { SemanticAdapterEvent } from './semantic-adapter.js';

function fixture() {
  const listeners = new Set<(event: RegistryEvent) => void>();
  const presentationListeners = new Set<(event: SemanticAdapterEvent) => void>();
  const registry = {
    listDescendants: () => [],
    subscribe(listener: (event: RegistryEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as AgentSessionRegistry;
  const ownerControl = {} as SubagentOwnerControlPort;
  const provider = createSubagentProvider({
    registry,
    ownerControl,
    presentationEvents: { subscribePresentation(listener) { presentationListeners.add(listener); return () => presentationListeners.delete(listener); } },
  });
  return {
    provider,
    publish: (event: RegistryEvent) => listeners.forEach((listener) => listener(event)),
    publishPresentation: (event: SemanticAdapterEvent) => presentationListeners.forEach((listener) => listener(event)),
  };
}

function session(withSavedOperation: boolean): BorrowedAgentSession {
  const saved = {
    operationId: 'send-call', kind: 'send',
    source: 'tool',
    placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'assistant-entry' },
    state: 'complete', data: { operation: 'send', to: ['worker'], request: 'Check config', response: 'All present' },
  };
  const branch = withSavedOperation ? [
    { type: 'message', id: 'assistant-entry', message: { role: 'assistant', content: [{ type: 'text', text: 'Before' }, { type: 'toolCall', id: 'send-call', name: 'send', arguments: { to: 'worker', message: 'Check config' } }] } },
    { type: 'message', id: 'result-entry', message: { role: 'toolResult', toolCallId: 'send-call', toolName: 'send', content: [{ type: 'text', text: 'model output' }], details: { subagentContent: [saved] } } },
  ] : [];
  return { sessionId: 'worker-session', messages: branch.map((entry) => entry.message), sessionManager: { getBranch: () => branch, getEntries: () => branch } } as unknown as BorrowedAgentSession;
}

describe('subagent presentation provider', () => {
  it('exposes an epoch-stable manifest that consumers cannot mutate', () => {
    const { provider } = fixture();
    const snapshot = provider.snapshot();
    expect(snapshot.manifest.hiddenToolNames).toEqual(expect.arrayContaining(['send', 'respond', 'subagent']));
    const before = [...snapshot.manifest.hiddenToolNames];
    try { (snapshot.manifest.hiddenToolNames as string[]).push('other'); } catch { /* Immutable values can reject mutation. */ }
    expect(snapshot.manifest.hiddenToolNames).toEqual(before);
    expect(provider.snapshot().manifest.hiddenToolNames).toEqual(before);
    expect(provider.snapshot().cursor.epoch).toBe(snapshot.cursor.epoch);
  });

  it('hydrates saved final content once in the same cursor sequence as topology events', async () => {
    const { provider, publish } = fixture();
    const savedSession = session(true);
    const boundary = provider.snapshot().cursor;
    const observed: unknown[] = [];
    provider.subscribe((event) => observed.push(event));
    publish({ type: 'node_added', node: { path: ['worker'], sessionId: 'worker-session', ownership: 'registry', operational: { state: 'idle' } } } as RegistryEvent);
    await provider.rehydrate({ session: savedSession, path: ['worker'] });
    await provider.rehydrate({ session: savedSession, path: ['worker'] });

    const replay = provider.replay(boundary);
    expect(replay.kind).toBe('events');
    if (replay.kind !== 'events') throw new Error('Expected replay');
    expect(replay.events).toEqual(observed);
    const finalEvents = replay.events.filter((event) => 'type' in event && event.type === 'subagent_snapshot_event');
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toMatchObject({ target: { operationId: 'send-call', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'assistant-entry' } }, data: { operation: 'send', to: ['worker'], request: 'Check config', response: 'All present' } });
    expect(JSON.stringify(finalEvents)).not.toContain('correlationId');
    const sequences = replay.events.map((event) => event.cursor.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('keeps active operations distinct when root and child paths reuse a tool call ID', () => {
    const { provider, publishPresentation } = fixture();
    const start = (path: readonly string[]) => publishPresentation({
      type: 'start',
      operationId: 'same-call',
      kind: 'send',
      path,
      placement: { toolCallId: 'same-call', contentIndex: 0 },
      data: { operation: 'send', to: ['worker'], request: 'check', response: '', phase: 'sending' },
    });
    start([]);
    start(['worker']);
    expect(provider.snapshot().activeOperations.map((operation) => operation.target.path)).toEqual([[], ['worker']]);

    publishPresentation({
      type: 'end',
      operationId: 'same-call',
      kind: 'send',
      path: [],
      placement: { toolCallId: 'same-call', contentIndex: 0 },
      state: 'complete',
      data: { operation: 'send', to: ['worker'], request: 'check', response: 'done' },
    });
    expect(provider.snapshot().activeOperations.map((operation) => operation.target.path)).toEqual([['worker']]);
  });

  it('does not invent a presentation operation when the native session has none', async () => {
    const { provider } = fixture();
    const before = provider.snapshot().cursor;
    await provider.rehydrate({ session: session(false), path: ['worker'] });
    const replay = provider.replay(before);
    expect(replay.kind).toBe('events');
    if (replay.kind !== 'events') throw new Error('Expected replay');
    expect(replay.events.filter((event) => 'type' in event && event.type === 'subagent_snapshot_event')).toEqual([]);
  });
});
