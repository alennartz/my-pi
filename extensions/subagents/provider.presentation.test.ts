import { describe, expect, it } from 'vitest';
import type { AgentSessionRegistry, RegistryEvent } from './agent-session-registry.js';
import { createSubagentProvider, type BorrowedAgentSession, type SubagentOwnerControlPort } from './provider.js';
import type { SemanticAdapterEvent } from './semantic-adapter.js';

function fixture(historyLimit?: number) {
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
    ...(historyLimit !== undefined ? { historyLimit } : {}),
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

async function rehydratedFinals(entries: readonly unknown[]) {
  const { provider } = fixture();
  const savedSession = { sessionId: 'saved-session', sessionManager: { getBranch: () => entries } } as unknown as BorrowedAgentSession;
  await provider.rehydrate({ session: savedSession, path: ['owner'] });
  const replay = provider.replay();
  provider.shutdown();
  if (replay.kind !== 'events') throw new Error('Expected replay');
  return replay.events.filter((event) => 'type' in event && event.type === 'subagent_snapshot_event');
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

  it('rehydrates persisted content again after bounded presentation history evicts it', async () => {
    const { provider, publishPresentation } = fixture(1);
    const savedSession = session(true);
    await provider.rehydrate({ session: savedSession, path: ['worker'] });
    publishPresentation({
      type: 'start',
      operationId: 'noise',
      kind: 'send',
      path: [],
      placement: { toolCallId: 'noise', contentIndex: 0 },
      data: { operation: 'send', to: ['worker'], request: 'noise', response: '', phase: 'sending' },
    });
    const before = provider.snapshot().cursor;
    await provider.rehydrate({ session: savedSession, path: ['worker'] });
    const replay = provider.replay(before);
    expect(replay.kind).toBe('events');
    if (replay.kind !== 'events') throw new Error('Expected replay');
    expect(replay.events).toContainEqual(expect.objectContaining({ type: 'subagent_snapshot_event', target: expect.objectContaining({ operationId: 'send-call', path: ['worker'] }) }));
  });

  it.each([false, true])('hydrates one await with its child output instead of a separate completion, interrupted=%s', async (interrupted) => {
    const statuses = [{ path: ['owner', 'worker'], state: 'errored', output: 'partial answer', error: 'failed', sessionId: 'worker-session' }];
    const completion = {
      operationId: 'embedded-completion', kind: 'completion', source: 'custom_entry', state: 'error',
      data: { operation: 'completion', result: { state: 'errored', output: 'partial answer', error: 'failed' } },
    };
    const incoming = {
      operationId: 'incoming-message', kind: 'send', source: 'custom_entry', state: 'complete',
      data: { operation: 'send', to: ['owner'], request: 'need a decision', response: '' },
    };
    const awaited = {
      operationId: 'await-call', kind: 'await', source: 'tool', state: 'complete',
      placement: { toolCallId: 'await-call', contentIndex: 0 },
      data: { operation: 'await', result: { statuses, ...(interrupted ? { interrupted: true } : {}) } },
    };
    const events = await rehydratedFinals([{
      type: 'message', id: 'await-result', message: {
        role: 'toolResult', toolName: 'await_agents', toolCallId: 'await-call',
        details: { subagentContent: [completion, ...(interrupted ? [incoming] : []), awaited] },
      },
    }]);
    expect(events.filter((event) => event.target.kind === 'completion')).toEqual([]);
    const awaits = events.filter((event) => event.target.kind === 'await');
    expect(awaits).toHaveLength(1);
    expect(awaits[0]).toMatchObject({ data: awaited.data });
    if (interrupted) expect(events).toContainEqual(expect.objectContaining({ target: expect.objectContaining({ kind: 'send' }), data: incoming.data }));
  });

  it('hydrates standalone completions only from actual subagents custom messages', async () => {
    const completion = (operationId: string) => ({
      operationId, kind: 'completion', source: 'custom_entry', state: 'complete',
      data: { operation: 'completion', result: { state: 'idle', output: operationId } },
    });
    const events = await rehydratedFinals([
      { type: 'custom_message', id: 'native-entry', customType: 'subagents', details: { subagentContent: [completion('native')] } },
      { type: 'message', id: 'nested-entry', message: { role: 'custom', customType: 'subagents', details: { subagentContent: [completion('nested')] } } },
      { type: 'custom_message', id: 'other-entry', customType: 'other', details: { subagentContent: [completion('other')] } },
      { type: 'custom', id: 'state-entry', customType: 'subagents', data: { subagentContent: [completion('state')] } },
      { type: 'message', id: 'tool-entry', message: { role: 'toolResult', toolName: 'await_agents', details: { subagentContent: [completion('tool')] } } },
    ]);
    expect(events.filter((event) => event.target.kind === 'completion').map((event) => event.data)).toEqual([
      completion('native').data,
      completion('nested').data,
    ]);
  });

  it.each([false, true])('restores missing settlements in saved refused awaits without replacing authoritative statuses, hasStatus=%s', async (hasStatus) => {
    const worker = { path: ['owner', 'worker'], state: 'idle', output: 'authoritative answer', sessionId: 'worker-session' };
    const scout = { path: ['owner', 'scout'], state: 'errored', output: 'scout output', error: 'scout failure', sessionId: 'scout-session' };
    const awaited = {
      operationId: 'refused-await', kind: 'await', source: 'tool', state: 'complete',
      placement: { toolCallId: 'refused-await', contentIndex: 0 },
      data: { operation: 'await', result: { statuses: hasStatus ? [worker] : [], interrupted: true, error: 'Cannot wait' } },
    };
    const entries = [{
      type: 'message', id: 'refused-result', message: {
        role: 'toolResult', toolName: 'await_agents', toolCallId: 'refused-await',
        details: {
          agents: [],
          semantic: [
            { kind: 'child_settled', data: { statuses: [scout, { ...worker, output: 'earlier answer' }] } },
            { kind: 'completion', path: ['owner', 'ignored'], data: { status: 'idle', output: 'not a settlement' } },
          ],
          subagentContent: [
            { operationId: 'embedded-completion', kind: 'completion', source: 'custom_entry', state: 'error', data: { operation: 'completion', result: { state: 'errored', output: scout.output, error: scout.error } } },
            awaited,
          ],
        },
      },
    }];
    const before = JSON.stringify(entries);
    const events = await rehydratedFinals(entries);
    expect(events.filter((event) => event.target.kind === 'completion')).toEqual([]);
    const awaits = events.filter((event) => event.target.kind === 'await');
    expect(awaits).toHaveLength(1);
    expect(awaits[0]).toMatchObject({ data: { operation: 'await', result: {
      interrupted: true, error: 'Cannot wait', statuses: expect.arrayContaining([scout, hasStatus ? worker : { ...worker, output: 'earlier answer' }]),
    } } });
    expect(JSON.stringify(awaits[0])).not.toContain('not a settlement');
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('keeps aborted awaits persisted as custom entries', async () => {
    const awaited = {
      operationId: 'aborted-await', kind: 'await', source: 'custom_entry', state: 'aborted',
      data: { operation: 'await', result: { statuses: [], interrupted: true } },
    };
    const events = await rehydratedFinals([{
      type: 'custom_message', id: 'aborted-entry', customType: 'subagents', details: { subagentContent: [awaited] },
    }]);
    expect(events).toEqual([expect.objectContaining({ target: expect.objectContaining({ kind: 'await' }), state: 'aborted', data: awaited.data })]);
  });

  it('does not invent a presentation operation when the native session has none', async () => {
    const events = await rehydratedFinals([{
      type: 'message', message: { role: 'toolResult', toolName: 'await_agents', details: {
        semantic: { kind: 'child_settled', data: { statuses: [{ path: ['owner', 'worker'], state: 'idle', output: 'legacy answer' }] } },
      } },
    }]);
    expect(events).toEqual([]);
  });
});
