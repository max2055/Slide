import { describe, expect, it, vi } from 'vitest';
import { routeMetricRead } from './source-router.js';

const ref = { type: 'instance' as const, id: 7 };

describe('formal metric consumer source router', () => {
  it('reads legacy only for a uniformly applied legacy resource', async () => {
    const legacy = vi.fn(async () => ({ qps: 12 }));
    const semantic = vi.fn(async () => ({ metrics: [] }));
    await expect(routeMetricRead(ref, async () => 'legacy', legacy, semantic))
      .resolves.toEqual({ source: 'legacy', data: { qps: 12 } });
    expect(legacy).toHaveBeenCalledOnce();
    expect(semantic).not.toHaveBeenCalled();
  });

  it('reads formal semantic evidence only for a uniformly applied V2 resource', async () => {
    const legacy = vi.fn(async () => ({ qps: 12 }));
    const semantic = vi.fn(async () => ({ metrics: [{ definition: { id: 'db.uptime_seconds' } }] }));
    await expect(routeMetricRead(ref, async () => 'v2', legacy, semantic))
      .resolves.toEqual({ source: 'v2', semantic: { metrics: [{ definition: { id: 'db.uptime_seconds' } }] } });
    expect(semantic).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('returns explicit pending state without consulting either store', async () => {
    const legacy = vi.fn();
    const semantic = vi.fn();
    await expect(routeMetricRead(ref, async () => 'pending', legacy, semantic))
      .resolves.toEqual({ source: 'pending' });
    expect(legacy).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
  });

  it('propagates source-state and selected-store failures instead of falling back', async () => {
    const legacy = vi.fn();
    const semantic = vi.fn();
    await expect(routeMetricRead(ref, async () => { throw new Error('SOURCE_UNAVAILABLE'); }, legacy, semantic))
      .rejects.toThrow('SOURCE_UNAVAILABLE');
    await expect(routeMetricRead(ref, async () => 'v2', legacy, async () => { throw new Error('V2_UNAVAILABLE'); }))
      .rejects.toThrow('V2_UNAVAILABLE');
    expect(legacy).not.toHaveBeenCalled();
  });
});
