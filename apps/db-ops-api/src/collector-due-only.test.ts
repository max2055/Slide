import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  recordMetrics: vi.fn(),
  resetFailures: vi.fn(),
}));

vi.mock('./collectors/registry.js', () => ({
  collectorRegistry: {
    register: vi.fn(),
    getProvidersByDbType: () => [{ name: 'mysql', collect: mocks.collect }],
    isEnabled: () => true,
    resetFailures: mocks.resetFailures,
    recordFailure: vi.fn(),
    disable: vi.fn(),
  },
}));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: () => ({ pool: {} }) } }));
vi.mock('./metrics-database-service.js', () => ({ metricsDatabaseService: { recordMetrics: mocks.recordMetrics } }));
vi.mock('./metric-registry.js', () => ({
  metricRegistry: {
    getByDbType: () => [
      { id: 'fast', name: 'fast', is_collected: true },
      { id: 'slow', name: 'slow', is_collected: true },
      { id: 'rare', name: 'rare', is_collected: true },
    ],
  },
}));
vi.mock('./collection-capabilities.js', () => ({ collectionCapabilityTracker: { recordMetricAttempt: vi.fn() } }));

import { unifiedCollector } from './collector.js';

describe('UnifiedCollector due-only boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collect.mockResolvedValue(42);
    mocks.recordMetrics.mockResolvedValue({ success: true });
  });

  it('collects and persists only metric IDs selected by the scheduler', async () => {
    const result = await unifiedCollector.collectInstance(
      { id: 9, db_type: 'mysql' } as any,
      ['slow'],
    );

    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(mocks.collect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'slow' }));
    expect(mocks.recordMetrics).toHaveBeenCalledWith({ instance_id: 9, metrics_data: { slow: 42 } });
    expect(result).toEqual({ slow: true });
  });

  it('reports selected metrics as failed when persistence fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.recordMetrics.mockResolvedValue({ success: false, error: 'write failed' });

    await expect(unifiedCollector.collectInstance(
      { id: 9, db_type: 'mysql' } as any,
      ['slow'],
    )).resolves.toEqual({ slow: false });
  });
});
