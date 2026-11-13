import { describe, expect, it } from 'vitest';
import { resolveExplicitAwait, type StoredChildSettlement } from './await-result.js';

const worker: StoredChildSettlement = { path: ['worker'], state: 'idle', output: 'already done', sessionId: 'worker-session' };
describe('explicit await resolution', () => {
  it('returns a child that settled before the call without waiting for a new run', () => {
    const result = resolveExplicitAwait([['worker']], [worker]);

    expect(result).toEqual({ statuses: [worker], pending: [] });
  });

  it('returns only unsettled paths as pending while preserving stored terminal statuses', () => {
    const result = resolveExplicitAwait([['worker'], ['scout']], [worker]);

    expect(result.statuses).toEqual([worker]);
    expect(result.pending).toEqual([['scout']]);
  });

  it('keeps errored and stopped settlements terminal instead of waiting again', () => {
    const errored: StoredChildSettlement = { path: ['worker'], state: 'errored', error: 'failed' };
    const stopped: StoredChildSettlement = { path: ['scout'], state: 'stopped', output: 'cancelled' };

    expect(resolveExplicitAwait([['worker'], ['scout']], [errored, stopped])).toEqual({
      statuses: [errored, stopped],
      pending: [],
    });
  });
});
