import { describe, expect, it, vi } from 'vitest';
import { sourceControlledObservations } from './resource-diagnostic-service.js';

const ref = { type: 'instance' as const, id: 9 };
const actor = { userId: 1, username: 'operator', permissions: ['*'] } as any;
const observation = {
  resource: ref,
  metricId: 'qps',
  value: 12,
  observedAt: new Date('2026-09-24T00:00:00.000Z'),
  validUntil: new Date('2026-09-24T00:05:00.000Z'),
  source: 'metrics_history',
  quality: 'good' as const,
};

describe('resource observation formal-source boundary', () => {
  it('reads legacy observations only while the whole resource remains legacy', async () => {
    const legacy = vi.fn(async () => [observation]);
    const read = sourceControlledObservations(async () => 'legacy', legacy);

    await expect(read(ref, actor, { limit: 10 })).resolves.toEqual([observation]);
    expect(legacy).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'v2'] as const)('does not expose legacy observations when formal source is %s', async (state) => {
    const legacy = vi.fn(async () => [observation]);
    const read = sourceControlledObservations(async () => state, legacy);

    await expect(read(ref, actor, { limit: 10 })).resolves.toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('fails closed when source state cannot be established', async () => {
    const legacy = vi.fn(async () => [observation]);
    const read = sourceControlledObservations(async () => { throw new Error('ROLLOUT_SOURCE_STATE'); }, legacy);

    await expect(read(ref, actor)).rejects.toThrow('ROLLOUT_SOURCE_STATE');
    expect(legacy).not.toHaveBeenCalled();
  });
});
