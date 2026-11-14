import { describe, expect, it } from 'vitest';
import { createSubagentSemanticAdapter } from './semantic-adapter.js';

function call(toolName: string, toolCallId = toolName, path: readonly string[] = []) {
  return { toolName, toolCallId, contentIndex: 0, path };
}

describe('subagent semantic adapter', () => {
  it('streams send prose while retaining complete public parameters and results', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('send');
    const start = adapter.acceptToolCallDelta({ ...input, phase: 'start', delta: '{"to":"worker","message":"Please verify' });
    const request = adapter.acceptToolCallDelta({ ...input, phase: 'delta', delta: ' the config","expectResponse":true}' });
    adapter.acceptToolCallDelta({ ...input, phase: 'end', delta: '{"to":"worker","message":"Please verify the config","expectResponse":true}' });
    const response = adapter.acceptResponseProgress('send', 'Everything is present.');
    const end = adapter.acceptToolExecution({ ...input, result: { response: 'Everything is present.', deferred: false, correlationId: 'private', metadata: { ok: true } } });
    expect(start).toContainEqual(expect.objectContaining({ type: 'start', data: { operation: 'send', parameters: { to: ['worker'], message: 'Please verify' }, result: { response: '', phase: 'sending' } } }));
    expect(request).toContainEqual(expect.objectContaining({ data: { operation: 'send', field: 'request', delta: ' the config' } }));
    expect(response).toContainEqual(expect.objectContaining({ data: { operation: 'send', field: 'response', delta: 'Everything is present.' } }));
    expect(end).toContainEqual(expect.objectContaining({ type: 'end', data: {
      operation: 'send', parameters: { to: ['worker'], message: 'Please verify the config', expectResponse: true },
      result: { response: 'Everything is present.', deferred: false, metadata: { ok: true } },
    } }));
    expect(JSON.stringify([...start, ...request, ...response, ...end])).not.toContain('private');
  });

  it('keeps respond prose in parameters and excludes private routing identifiers', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('respond', 'respond', ['worker']);
    const start = adapter.acceptToolCallDelta({ ...input, phase: 'start', delta: '{"correlationId":"private-id","message":"Every' });
    expect(adapter.getArgument('respond', 'correlationId')).toBe('private-id');
    const delta = adapter.acceptToolCallDelta({ ...input, phase: 'delta', delta: 'thing is present."}' });
    const end = adapter.acceptToolExecution({ ...input, result: { accepted: true, metadata: { correlation_id: 'private-id', source: 'peer' } } });
    expect(start).toContainEqual(expect.objectContaining({ data: { operation: 'respond', parameters: { message: 'Every' }, result: {} } }));
    expect(delta).toContainEqual(expect.objectContaining({ data: { operation: 'respond', delta: 'thing is present.' } }));
    expect(end).toContainEqual(expect.objectContaining({ data: { operation: 'respond', parameters: { message: 'Everything is present.' }, result: { accepted: true, metadata: { source: 'peer' } } } }));
    expect(JSON.stringify([...start, ...delta, ...end])).not.toContain('private-id');
  });

  it.each([{}, { agents: ['worker', 'scout'] }])('defers await until authoritative arguments are complete: %j', (parameters) => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('await_agents', 'await', ['owner']);
    expect(adapter.acceptToolCallDelta({ ...input, phase: 'start', delta: '{"agents":[' })).toEqual([]);
    expect(adapter.acceptToolCallDelta({ ...input, phase: 'delta', delta: '"worker"' })).toEqual([]);
    const worker = { path: ['owner', 'worker'], state: 'idle', output: 'done' } as const;
    expect(adapter.acceptAwaitProgress('await', [worker])).toEqual([]);
    const start = adapter.acceptToolCallDelta({ ...input, phase: 'end', delta: JSON.stringify(parameters) });
    const normalized = 'agents' in parameters ? { agents: [['owner', 'worker'], ['owner', 'scout']] } : {};
    expect(start).toContainEqual(expect.objectContaining({ type: 'start', data: { operation: 'await', parameters: normalized, result: { statuses: [worker] } } }));
    const scout = { path: ['owner', 'scout'], state: 'errored', error: 'failed' } as const;
    const progress = adapter.acceptAwaitProgress('await', [scout]);
    expect(progress).toContainEqual(expect.objectContaining({ data: { operation: 'await', statuses: [worker, scout] } }));
    const end = adapter.acceptToolExecution({ ...input, result: { agents: [worker, scout], interrupted: true, metadata: { reason: 'message' } } });
    expect(end).toContainEqual(expect.objectContaining({ data: { operation: 'await', parameters: normalized, result: { statuses: [worker, scout], interrupted: true, metadata: { reason: 'message' } } } }));
  });

  it('represents an await when only its execution result arrives', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('await_agents', 'result-only');
    const events = adapter.acceptToolExecution({ ...input, parameters: { agents: ['worker'] }, result: { agents: [{ id: 'worker', status: 'idle' }] } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'start', operationId: 'result-only', kind: 'await' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'end', operationId: 'result-only', state: 'complete', data: expect.objectContaining({ result: expect.objectContaining({ statuses: [expect.objectContaining({ path: ['worker'], state: 'idle' })] }) }) }));
  });

  it('omits unknown await child states and keeps wait outcome independent of child state', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('await_agents', 'unknown-await');
    adapter.acceptToolExecutionStart({ ...input, arguments: { agents: ['worker', 'scout'] } });
    const [event] = adapter.acceptToolExecution({ ...input, result: {
      state: 'error', agents: [{ id: 'worker', state: 'running' }, { id: 'scout', state: 'mystery' }, { id: 'other' }],
    } });
    expect(event).toMatchObject({ state: 'complete', data: { result: { statuses: [{ path: ['worker'], state: 'running' }] } } });
  });

  it('does not reuse a progress state when a terminal result has no known state', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('await_agents', 'missing-state');
    adapter.acceptToolExecutionStart({ ...input, arguments: { agents: ['worker'] } });
    adapter.acceptAwaitProgress('missing-state', [{ path: ['worker'], state: 'idle' }]);
    const [event] = adapter.acceptToolExecution({ ...input, result: { agents: [{ id: 'worker' }] } });
    expect(event).toMatchObject({ data: { result: { statuses: [] } } });
  });

  it('uses execution-start arguments when no complete await stream event arrives', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('await_agents', 'await', ['owner']);
    adapter.acceptToolCallDelta({ ...input, phase: 'start', delta: '{"agents":[' });
    const start = adapter.acceptToolExecutionStart({ ...input, arguments: { agents: ['worker'] } });
    expect(start).toContainEqual(expect.objectContaining({ type: 'start', data: { operation: 'await', parameters: { agents: [['owner', 'worker']] }, result: { statuses: [] } } }));
    const aborted = adapter.completeToolCall('await');
    expect(aborted).toContainEqual(expect.objectContaining({ state: 'aborted', data: { operation: 'await', parameters: { agents: [['owner', 'worker']] }, result: { statuses: [], interrupted: true } } }));
  });

  it.each([
    ['subagent', { agents: [{ id: 'worker', task: 'inspect', persona: 'scout', model: 'smart', channels: ['peer'], cwd: '/repo' }] }, { agents: [{ id: 'worker', status: 'running', metadata: { ready: true } }], note: 'spawned' }, 'delegation'],
    ['fork', { id: 'worker', task: 'inspect' }, { agents: [{ id: 'worker', status: 'running' }], note: 'forked' }, 'delegation'],
    ['interrupt', { agents: ['worker'] }, { interrupted: [{ id: 'worker', output: 'done', metadata: { acknowledged: true } }], pending: [], failed: [], aborted: true }, 'interrupt'],
    ['teardown', { agent: 'worker' }, { status: 'removed', affectedAgents: [{ id: 'worker', sessionId: 'saved', state: 'idle', usage: { turns: 1 }, usageBaseline: { turns: 0 } }], notes: ['removed'] }, 'teardown'],
    ['resurrect', { agents: [{ id: 'worker', sessionId: 'saved', task: 'continue', channels: ['peer'], model: 'smart' }] }, { agents: [{ id: 'worker', sessionId: 'saved', state: 'running', usage: { turns: 0 }, metadata: { resumed: true } }], notes: ['resumed'] }, 'resurrect'],
  ] as const)('retains complete public inputs and outputs for %s', (toolName, parameters, result, operation) => {
    const adapter = createSubagentSemanticAdapter({ delegation: () => [{ path: ['owner', 'worker'], task: 'inspect', persona: 'scout' }] });
    const input = call(toolName, toolName, ['owner']);
    expect(adapter.acceptToolCallDelta({ ...input, phase: 'end', delta: JSON.stringify(parameters) })).toEqual([]);
    const [event] = adapter.acceptToolExecution({ ...input, result: { ...result, correlationId: 'private', metadata: { correlation_id: 'private', publicFlag: false } } });
    expect(event).toMatchObject({ type: 'snapshot', data: { operation, parameters: expect.any(Object), result: { metadata: { publicFlag: false } } } });
    if (toolName === 'interrupt') expect(event).toMatchObject({ data: { parameters: { agents: [['owner', 'worker']] }, result: { aborted: true, interrupted: [{ path: ['owner', 'worker'], output: 'done', metadata: { acknowledged: true } }] } } });
    else if (toolName === 'teardown') expect(event).toMatchObject({ data: { parameters: { agent: ['owner', 'worker'] }, result: { notes: ['removed'], affectedAgents: [{ path: ['owner', 'worker'], usageBaseline: { turns: 0 } }] } } });
    else if (toolName === 'resurrect') expect(event).toMatchObject({ data: { parameters, result: { notes: ['resumed'], affectedAgents: [{ path: ['owner', 'worker'], metadata: { resumed: true } }] } } });
    else expect(event).toMatchObject({ data: { parameters, result: { children: [{ path: ['owner', 'worker'], task: 'inspect', persona: 'scout', status: 'running' }] } } });
    expect(JSON.stringify(event)).not.toContain('private');
  });

  it('preserves native tool errors without exposing private result metadata', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('await_agents', 'failed-await');
    adapter.acceptToolExecutionStart({ ...input, arguments: { agents: ['worker'] } });
    const [event] = adapter.acceptToolExecution({ ...input, isError: true, result: {
      details: { semantic: { correlationId: 'private' } }, content: [{ type: 'text', text: 'Wait cancelled.' }],
    } });
    expect(event).toMatchObject({ state: 'error', data: { operation: 'await', parameters: { agents: [['worker']] }, result: { statuses: [], error: 'Wait cancelled.', isError: true } } });
    expect(JSON.stringify(event)).not.toContain('private');
  });

  it('redacts private identifiers from native routing errors but preserves response prose', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('respond', 'routing-error');
    adapter.acceptToolExecutionStart({ ...input, arguments: { correlationId: 'private-route', message: 'answer' } });
    const [event] = adapter.acceptToolExecution({ ...input, isError: true, result: {
      content: [{ type: 'text', text: 'No recorded response origin for correlation ID "private-route".' }], details: {},
    } });
    expect(event).toMatchObject({ data: { parameters: { message: 'answer' }, result: { error: 'No recorded response origin for correlation ID "[redacted]".' } } });
    expect(JSON.stringify(event)).not.toContain('private-route');
  });

  it('uses router-resolved send targets and preserves parameters on aborted sends', () => {
    const adapter = createSubagentSemanticAdapter();
    const input = call('send', 'send', ['child']);
    adapter.acceptToolCallDelta({ ...input, targetPath: ['sibling'], phase: 'end', delta: '{"to":"sibling","message":"check","expectResponse":true}' });
    expect(adapter.completeToolCall('send')).toContainEqual(expect.objectContaining({ state: 'aborted', data: { operation: 'send', parameters: { to: ['sibling'], message: 'check', expectResponse: true }, result: { response: '' } } }));
  });
});
