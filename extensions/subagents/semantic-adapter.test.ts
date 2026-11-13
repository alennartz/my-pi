import { describe, expect, it } from 'vitest';
import {
  createSubagentSemanticAdapter,
  type SubagentSemanticAdapter,
} from './semantic-adapter.js';

function adapter(): SubagentSemanticAdapter {
  return createSubagentSemanticAdapter({ operationId: ({ toolCallId }) => `operation:${toolCallId}` });
}

describe('SubagentSemanticAdapter', () => {
  it('projects partial send arguments into one stable typed start and ordered body deltas', () => {
    const current = adapter();
    const start = current.acceptToolCallDelta({
      toolCallId: 'send-call',
      contentIndex: 1,
      toolName: 'send',
      path: ['worker'],
      phase: 'start',
      delta: '{"to":"worker","message":"Please verify',
    });
    const delta = current.acceptToolCallDelta({
      toolCallId: 'send-call',
      contentIndex: 1,
      toolName: 'send',
      path: ['worker'],
      phase: 'delta',
      delta: ' the configuration"}',
    });

    expect(start).toEqual([
      expect.objectContaining({
        type: 'start',
        operationId: 'operation:send-call',
        kind: 'send',
        placement: { toolCallId: 'send-call', contentIndex: 1 },
        data: { operation: 'send', body: 'Please verify' },
      }),
    ]);
    expect(delta).toEqual([
      expect.objectContaining({
        type: 'delta',
        operationId: 'operation:send-call',
        data: { operation: 'send', delta: ' the configuration' },
      }),
    ]);
    expect(JSON.stringify(start[0])).not.toContain('correlationId');
    expect(JSON.stringify(delta[0])).not.toContain('correlationId');
  });

  it('keeps respond body progress separate from router correlation metadata', () => {
    const current = adapter();
    const events = current.acceptToolCallDelta({
      toolCallId: 'respond-call',
      contentIndex: 2,
      toolName: 'respond',
      path: ['worker'],
      phase: 'delta',
      delta: '{"correlationId":"corr-1","message":"Everything required is present."}',
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'delta',
        kind: 'respond',
        data: { operation: 'respond', delta: 'Everything required is present.' },
      }),
    ]);
    expect(events[0]).not.toHaveProperty('correlationId');
    expect(events[0]).not.toHaveProperty('data.correlationId');
  });

  it('emits one complete finite teardown payload without synthetic deltas', () => {
    const events = adapter().acceptToolExecution({
      toolCallId: 'teardown-call',
      contentIndex: 0,
      toolName: 'teardown',
      path: ['worker'],
      result: {
        status: 'removed',
        affectedAgents: [{
          path: ['worker'],
          sessionId: 'worker-session',
          incarnation: 'worker-incarnation',
          state: 'idle',
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          output: 'done',
        }],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'end',
      kind: 'teardown',
      data: {
        operation: 'teardown',
        result: { affectedAgents: [expect.objectContaining({ sessionId: 'worker-session', usage: expect.any(Object) })] },
      },
    });
    expect(events.some((event) => event.type === 'delta')).toBe(false);
  });

  it('emits an explicit protocol-error event when a declared replacement lacks a lifecycle', () => {
    const events = adapter().completeToolCall('send-call');

    expect(events).toEqual([
      expect.objectContaining({
        type: 'protocol_error',
        operationId: 'operation:send-call',
        kind: 'send',
        message: expect.any(String),
      }),
    ]);
  });

  it('uses toolCallId and contentIndex as the live target while allowing entryId only in persisted placement', () => {
    const [event] = adapter().acceptToolExecution({
      toolCallId: 'interrupt-call',
      contentIndex: 3,
      toolName: 'interrupt',
      path: ['worker'],
      result: { status: 'interrupted' },
    });

    expect(event).toMatchObject({ placement: { toolCallId: 'interrupt-call', contentIndex: 3 } });
    expect(event.placement).not.toHaveProperty('entryId');
  });

});
