import { describe, expect, it } from 'vitest';
import { MessageRouter, type RoutedResponseProgress } from './message-router.js';

function fixture() {
  const progress: RoutedResponseProgress[] = [];
  const router = new MessageRouter({
    correlationIdFactory: () => 'corr-1',
    onResponseProgress: (event) => progress.push(event),
  });
  router.addAgents([{ id: 'worker', channels: ['parent'] }]);
  return { router, progress, parent: router.connect('parent'), worker: router.connect('worker') };
}

describe('MessageRouter response progress', () => {
  it('forwards responder body deltas while the sender remains blocked', async () => {
    const { router, parent, worker, progress } = fixture();
    const received: string[] = [];
    worker.subscribe((message) => {
      received.push(message.message);
    });

    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true });
    expect(receipt.correlationId).toBe('corr-1');
    expect(worker.responseProgress).toBeTypeOf('function');
    if (!worker.responseProgress) return;

    await worker.responseProgress('corr-1', 'Everything required');
    await worker.responseProgress('corr-1', ' is present.');

    expect(progress).toEqual([
      { from: 'worker', to: 'parent', correlationId: 'corr-1', delta: 'Everything required' },
      { from: 'worker', to: 'parent', correlationId: 'corr-1', delta: ' is present.' },
    ]);
    expect(received).toEqual(['verify config']);
    expect(router.isQuiet()).toBe(false);

    await worker.respond('corr-1', 'Everything required is present.');
    await expect(receipt.response).resolves.toEqual({ type: 'response', message: 'Everything required is present.' });
    expect(router.isQuiet()).toBe(true);
  });

  it('rejects progress from an endpoint that does not own the pending correlation', async () => {
    const { parent, worker } = fixture();
    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true });
    expect(worker.responseProgress).toBeTypeOf('function');
    if (!worker.responseProgress) return;

    await expect(worker.responseProgress('corr-missing', 'not allowed')).rejects.toThrow(/pending|correlation/i);
    await worker.respond('corr-1', 'done');
    await expect(receipt.response).resolves.toMatchObject({ type: 'response' });
  });

  it('does not expose response progress as a provider presentation event', async () => {
    const { parent, worker, progress } = fixture();
    const receipt = await parent.send({ to: 'worker', message: 'verify config', expectResponse: true });
    expect(worker.responseProgress).toBeTypeOf('function');
    if (!worker.responseProgress) return;
    await worker.responseProgress('corr-1', 'partial');

    expect(progress[0]).toMatchObject({ from: 'worker', to: 'parent', delta: 'partial' });
    expect(progress[0]).toHaveProperty('correlationId', 'corr-1');
    await worker.respond('corr-1', 'done');
    await expect(receipt.response).resolves.toMatchObject({ type: 'response' });
  });
});
