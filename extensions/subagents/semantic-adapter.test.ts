import { describe, expect, it } from 'vitest';
import { createSubagentSemanticAdapter } from './semantic-adapter.js';

describe('subagent semantic adapter', () => {
  it('streams a send request and its response into the same tool-backed operation', () => {
    const adapter = createSubagentSemanticAdapter();
    const start = adapter.acceptToolCallDelta({ toolCallId: 'send-call', contentIndex: 1, toolName: 'send', path: [], phase: 'start', delta: '{"to":"worker","message":"Please verify' });
    const request = adapter.acceptToolCallDelta({ toolCallId: 'send-call', contentIndex: 1, toolName: 'send', path: [], phase: 'delta', delta: ' the config"}' });
    const response = adapter.acceptResponseProgress('send-call', 'Everything is present.');
    const end = adapter.acceptToolExecution({ toolCallId: 'send-call', contentIndex: 1, toolName: 'send', path: [], result: { message: 'Everything is present.' } });

    expect(start).toContainEqual(expect.objectContaining({ type: 'start', operationId: 'send-call', kind: 'send', placement: { toolCallId: 'send-call', contentIndex: 1 }, data: expect.objectContaining({ operation: 'send', request: 'Please verify' }) }));
    expect(request).toContainEqual(expect.objectContaining({ type: 'delta', operationId: 'send-call', data: { operation: 'send', field: 'request', delta: ' the config' } }));
    expect(response).toContainEqual(expect.objectContaining({ type: 'delta', operationId: 'send-call', data: { operation: 'send', field: 'response', delta: 'Everything is present.' } }));
    expect(end).toContainEqual(expect.objectContaining({ type: 'end', operationId: 'send-call', data: expect.objectContaining({ operation: 'send', request: 'Please verify the config', response: 'Everything is present.' }) }));
    expect(JSON.stringify([...start, ...request, ...response, ...end])).not.toContain('correlationId');
  });

  it('streams a separate respond operation without publishing router metadata', () => {
    const adapter = createSubagentSemanticAdapter();
    const start = adapter.acceptToolCallDelta({ toolCallId: 'respond-call', contentIndex: 0, toolName: 'respond', path: ['worker'], phase: 'start', delta: '{"correlationId":"private-id","message":"Every' });
    const delta = adapter.acceptToolCallDelta({ toolCallId: 'respond-call', contentIndex: 0, toolName: 'respond', path: ['worker'], phase: 'delta', delta: 'thing is present."}' });
    const end = adapter.acceptToolExecution({ toolCallId: 'respond-call', contentIndex: 0, toolName: 'respond', path: ['worker'], result: {} });

    expect(start).toContainEqual(expect.objectContaining({ type: 'start', operationId: 'respond-call', kind: 'respond', data: { operation: 'respond', body: 'Every' } }));
    expect(delta).toContainEqual(expect.objectContaining({ type: 'delta', operationId: 'respond-call', data: { operation: 'respond', delta: 'thing is present.' } }));
    expect(end).toContainEqual(expect.objectContaining({ type: 'end', operationId: 'respond-call', data: expect.objectContaining({ operation: 'respond', body: 'Everything is present.' }) }));
    expect(JSON.stringify([...start, ...delta, ...end])).not.toContain('private-id');
  });

  it('streams await progress and completes with every requested child status', () => {
    const adapter = createSubagentSemanticAdapter();
    const requested = [['worker'], ['scout']];
    const start = adapter.acceptToolCallDelta({ toolCallId: 'await-call', contentIndex: 2, toolName: 'await_agents', path: [], phase: 'start', delta: '{"agents":["worker","scout"]}' });
    const worker = { path: ['worker'], state: 'idle', output: 'done' } as const;
    const scout = { path: ['scout'], state: 'errored', error: 'failed' } as const;
    const progress = adapter.acceptAwaitProgress('await-call', [worker]);
    const end = adapter.acceptToolExecution({ toolCallId: 'await-call', contentIndex: 2, toolName: 'await_agents', path: [], result: { statuses: [worker, scout] } });
    expect(start).toContainEqual(expect.objectContaining({ type: 'start', operationId: 'await-call', data: expect.objectContaining({ operation: 'await', requested }) }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'delta', operationId: 'await-call', data: { operation: 'await', statuses: [worker] } }));
    expect(end).toContainEqual(expect.objectContaining({ type: 'end', operationId: 'await-call', data: { operation: 'await', result: { statuses: [worker, scout] } } }));
  });

  it('preserves every affected teardown result in one finite snapshot', () => {
    const affectedAgents = [
      { path: ['worker'], sessionId: 'worker-session', incarnation: 'worker-incarnation', state: 'idle', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, output: 'done' },
      { path: ['scout'], sessionId: 'scout-session', incarnation: 'scout-incarnation', state: 'errored', usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 0, cost: 0.1, turns: 2 }, error: 'failed' },
    ];
    const events = createSubagentSemanticAdapter().acceptToolExecution({ toolCallId: 'teardown-call', contentIndex: 3, toolName: 'teardown', path: [], result: { status: 'removed', affectedAgents } });

    expect(events).toEqual([expect.objectContaining({ type: 'snapshot', operationId: 'teardown-call', kind: 'teardown', placement: { toolCallId: 'teardown-call', contentIndex: 3 }, data: { operation: 'teardown', result: { status: 'removed', affectedAgents } } })]);
  });
});
