import { describe, expect, it } from 'vitest';
import { MessageRouter } from './message-router.js';
import type { ResponseProgress } from './message-router.js';

function fixture() {
  const router = new MessageRouter({ correlationIdFactory: () => 'corr-1' });
  router.addAgents([{ id: 'worker', channels: ['parent'] }, { id: 'scout', channels: ['parent'] }]);
  return { router, parent: router.connect('parent'), worker: router.connect('worker'), scout: router.connect('scout') };
}

describe('router response progress', () => {
  it('streams the reply text to the sender of that request before the authoritative response', async () => {
    const { parent, worker } = fixture();
    const progress: ResponseProgress[] = [];
    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true, onProgress: (update) => progress.push(update) });
    let settled = false;
    void receipt.response!.then(() => { settled = true; });

    worker.responseProgress('corr-1', { attempt: 'call-a', text: 'Everything' });
    worker.responseProgress('corr-1', { attempt: 'call-b', text: 'All' });
    expect(progress).toEqual([{ attempt: 'call-a', text: 'Everything' }, { attempt: 'call-b', text: 'All' }]);
    expect(settled).toBe(false);

    await worker.respond('corr-1', 'All present.');
    await expect(receipt.response).resolves.toEqual({ type: 'response', message: 'All present.' });
  });

  it('rejects progress from an endpoint that does not own the pending request', async () => {
    const { parent, worker, scout } = fixture();
    const progress: ResponseProgress[] = [];
    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true, onProgress: (update) => progress.push(update) });

    expect(() => scout.responseProgress('corr-1', { attempt: 'x', text: 'not allowed' })).toThrow();
    expect(progress).toEqual([]);
    await worker.respond('corr-1', 'done');
    await expect(receipt.response).resolves.toMatchObject({ type: 'response', message: 'done' });
  });
});
