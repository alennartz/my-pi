import { describe, expect, it } from 'vitest';
import { MessageRouter, type RoutedResponseProgress } from './message-router.js';

function fixture() {
  const progress: RoutedResponseProgress[] = [];
  const router = new MessageRouter({ correlationIdFactory: () => 'corr-1', onResponseProgress: (event) => progress.push(event) });
  router.addAgents([{ id: 'worker', channels: ['parent'] }, { id: 'scout', channels: ['parent'] }]);
  return { router, progress, parent: router.connect('parent'), worker: router.connect('worker'), scout: router.connect('scout') };
}

describe('router response progress', () => {
  it('forwards ordered progress without resolving the sender before the authoritative response', async () => {
    const { parent, worker, progress } = fixture();
    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true });
    let settled = false;
    receipt.response!.then(() => { settled = true; });

    await worker.responseProgress!('corr-1', 'Everything required');
    await worker.responseProgress!('corr-1', ' is present.');
    expect(progress).toEqual([
      expect.objectContaining({ from: 'worker', to: 'parent', delta: 'Everything required' }),
      expect.objectContaining({ from: 'worker', to: 'parent', delta: ' is present.' }),
    ]);
    expect(settled).toBe(false);

    await worker.respond('corr-1', 'Everything required is present.');
    await expect(receipt.response).resolves.toEqual({ type: 'response', message: 'Everything required is present.' });
  });

  it('rejects progress from an endpoint that does not own the pending request', async () => {
    const { parent, worker, scout, progress } = fixture();
    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true });

    await expect(scout.responseProgress!('corr-1', 'not allowed')).rejects.toThrow();
    expect(progress).toEqual([]);
    await worker.respond('corr-1', 'done');
    await expect(receipt.response).resolves.toMatchObject({ type: 'response', message: 'done' });
  });
});
