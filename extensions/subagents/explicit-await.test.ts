import { describe, expect, it, vi } from 'vitest';
import { createSubagentsExtension } from './scoped-extension.js';

async function tools() {
  const pi = { registerTool: vi.fn() };
  await createSubagentsExtension({ kind: 'root' })(pi as any);
  return pi.registerTool.mock.calls.map(([tool]) => tool);
}

describe('explicit await delegation contract', () => {
  it('does not expose await on finite subagent or fork delegation inputs', async () => {
    const registered = await tools();
    const subagent = registered.find((tool) => tool.name === 'subagent');
    const fork = registered.find((tool) => tool.name === 'fork');

    expect(subagent).toBeDefined();
    expect(fork).toBeDefined();
    expect(subagent!.parameters).not.toHaveProperty('properties.await');
    expect(fork!.parameters).not.toHaveProperty('properties.await');
    expect(subagent!.parameters).not.toHaveProperty('properties.awaitResult');
    expect(fork!.parameters).not.toHaveProperty('properties.awaitResult');
  });

});
