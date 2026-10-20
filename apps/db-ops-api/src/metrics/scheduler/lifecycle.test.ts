import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MetricSchedulerLifecycle, metricCollectionEnabled } from './lifecycle.js';

const deferred = () => { let resolve!: (n: number) => void; const promise = new Promise<number>(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
describe('application-owned metric scheduler lifecycle', () => {
  it('defaults off and rejects ambiguous activation values', () => {
    expect(metricCollectionEnabled(undefined)).toBe(false);
    expect(metricCollectionEnabled('false')).toBe(false);
    expect(metricCollectionEnabled('true')).toBe(true);
    expect(() => metricCollectionEnabled('1')).toThrow('METRIC_COLLECTION_ENABLED_INVALID');
  });
  it('registers a fail-closed handler while disabled without touching migrations or scheduling', async () => {
    const registry = new JobRegistry(), ready = vi.fn(), tick = vi.fn(), register = vi.fn();
    const lifecycle = new MetricSchedulerLifecycle({ tick, register }, { enabled: false });
    await lifecycle.start(registry, ready);
    await expect(registry.execute({ id: 'old', type: 'metrics.collect', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 1 },
      { workerId: 'w', fencingToken: 1, signal: new AbortController().signal })).rejects.toThrow('METRIC_COLLECTION_DISABLED');
    expect(ready).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    expect(await lifecycle.stop()).toBe(true);
  });
  it('checks migrations before registering or queuing work', async () => {
    const tick = vi.fn(), register = vi.fn();
    const lifecycle = new MetricSchedulerLifecycle({ tick, register }, { enabled: true });
    await expect(lifecycle.start(new JobRegistry(), async () => { throw new Error('missing table'); })).rejects.toThrow('missing table');
    expect(tick).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
  it('never overlaps slow ticks, recovers failures and redacts raw errors', async () => {
    vi.useFakeTimers();
    const gate = deferred(), report = vi.fn();
    const tick = vi.fn().mockResolvedValueOnce(1).mockImplementationOnce(() => gate.promise)
      .mockRejectedValueOnce(new Error('password=secret')).mockResolvedValue(0);
    const lifecycle = new MetricSchedulerLifecycle({ tick, register: vi.fn() }, { enabled: true, report });
    await lifecycle.start(new JobRegistry(), async () => {});
    await vi.advanceTimersByTimeAsync(6000); expect(tick).toHaveBeenCalledTimes(2);
    gate.resolve(2); await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'METRIC_TICK_FAILED' }));
    expect(await lifecycle.stop()).toBe(true);
    await vi.advanceTimersByTimeAsync(10000); expect(tick).toHaveBeenCalledTimes(4);
  });
  it('bounds shutdown, quarantines outstanding tick and does not restart after it settles', async () => {
    vi.useFakeTimers();
    const gate = deferred(), tick = vi.fn().mockResolvedValueOnce(0).mockImplementationOnce(() => gate.promise);
    const lifecycle = new MetricSchedulerLifecycle({ tick, register: vi.fn() }, { enabled: true, shutdownMs: 50 });
    await lifecycle.start(new JobRegistry(), async () => {}); await vi.advanceTimersByTimeAsync(1000);
    const stopping = lifecycle.stop(); await vi.advanceTimersByTimeAsync(50); expect(await stopping).toBe(false);
    gate.resolve(1); await vi.advanceTimersByTimeAsync(5000); expect(tick).toHaveBeenCalledTimes(2);
    expect(await lifecycle.stop()).toBe(true);
    await expect(lifecycle.start(new JobRegistry(), async () => {})).rejects.toThrow('METRIC_LIFECYCLE_ALREADY_STARTED');
  });
});
