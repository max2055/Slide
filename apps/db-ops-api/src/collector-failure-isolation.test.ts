import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ definitions: [] as Array<Record<string, unknown>> }));
const recordMetrics = vi.hoisted(() => vi.fn());

vi.mock('./database-service.js', () => ({ databaseService: { getConnection: () => ({ pool: {} }) } }));
vi.mock('./metrics-database-service.js', () => ({ metricsDatabaseService: { recordMetrics } }));
vi.mock('./metric-registry.js', () => ({ metricRegistry: { getByDbType: () => state.definitions } }));
vi.mock('./collection-capabilities.js', () => ({ collectionCapabilityTracker: { recordMetricAttempt: vi.fn() } }));

import { unifiedCollector } from './collector.js';
import { collectorRegistry } from './collectors/registry.js';
import { SystemFailurePublisher, installSystemFailurePublisher } from './platform/system-failure-publisher.js';

describe('UnifiedCollector provider failure isolation', () => {
  it('publishes only stable failure facts, with correlation, without resource credentials or provider message', async () => {
    const record = vi.fn(async () => {}), publisher = new SystemFailurePublisher(record), uninstall = installSystemFailurePublisher(publisher);
    const provider = { name: 'system-failure-fixture', supportedDbTypes: ['system-failure'], collect: vi.fn().mockRejectedValue(new Error('password=private')) };
    collectorRegistry.register(provider as any); state.definitions = [{ id: 'a', name: 'a', is_collected: true }];
    try {
      await unifiedCollector.collectInstance({ id: 999, db_type: 'system-failure', host: 'private-host' } as any);
      await publisher.drain();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'collector', stableErrorCode: 'COLLECTOR_PROVIDER_FAILED',
        callsite: 'collector:provider.collect', origin: 'collector', correlationId: expect.any(String) }));
      expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    } finally { uninstall(); }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    recordMetrics.mockResolvedValue({ success: true });
  });

  it('disables only the failing instance scope after three failed collection rounds', async () => {
    const collect = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const provider = { name: 'qualification-three-failures', supportedDbTypes: ['qualification'], collect };
    collectorRegistry.register(provider as any);
    state.definitions = ['a', 'b', 'c'].map((id) => ({ id, name: id, is_collected: true }));

    await unifiedCollector.collectInstance({ id: 10, db_type: 'qualification' } as any);
    await unifiedCollector.collectInstance({ id: 10, db_type: 'qualification' } as any);
    await unifiedCollector.collectInstance({ id: 10, db_type: 'qualification' } as any);

    expect(collect).toHaveBeenCalledTimes(9);
    expect(collectorRegistry.isEnabled(provider.name, 'instance:10')).toBe(false);
    expect(collectorRegistry.isEnabled(provider.name, 'instance:11')).toBe(true);
    await unifiedCollector.collectInstance({ id: 10, db_type: 'qualification' } as any);
    expect(collect).toHaveBeenCalledTimes(9);
  });

  it('resets the consecutive failure count after a successful collection', async () => {
    const collect = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(42)
      .mockRejectedValueOnce(new Error('after reset 1'))
      .mockRejectedValueOnce(new Error('after reset 2'));
    const provider = { name: 'qualification-success-reset', supportedDbTypes: ['qualification-reset'], collect };
    collectorRegistry.register(provider as any);
    state.definitions = [{ id: 'metric', name: 'metric', is_collected: true }];
    const instance = { id: 20, db_type: 'qualification-reset' } as any;

    await unifiedCollector.collectInstance(instance);
    await unifiedCollector.collectInstance(instance);
    await unifiedCollector.collectInstance(instance);
    await unifiedCollector.collectInstance(instance);

    expect(collect).toHaveBeenCalledTimes(4);
    expect(collectorRegistry.isEnabled(provider.name, 'instance:20')).toBe(true);
  });
});
