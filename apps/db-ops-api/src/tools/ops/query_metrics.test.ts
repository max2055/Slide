import { beforeEach, describe, expect, it, vi } from 'vitest';

const instanceService = vi.hoisted(() => ({ getInstanceById: vi.fn() }));
const metricsService = vi.hoisted(() => ({
  getRealtimeMetrics: vi.fn(),
  getRealtimeMetricsWithStatus: vi.fn(),
  getHistoricalMetricsWithRange: vi.fn(),
  getHistoricalMetricsWithRangeStatus: vi.fn(),
}));

vi.mock('../../instance-database-service.js', () => ({ instanceDatabaseService: instanceService }));
vi.mock('../../metrics-database-service.js', () => ({ metricsDatabaseService: metricsService }));

import { queryMetricsTool } from './query_metrics.js';

describe('query_metrics boundary scenarios', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not turn an unknown instance into a successful empty response', async () => {
    instanceService.getInstanceById.mockResolvedValue(null);
    const result = await queryMetricsTool.handler({ instance_id: 999 });
    expect(result).toMatchObject({ success: false, errorCode: 'INSTANCE_NOT_FOUND' });
    expect(metricsService.getRealtimeMetrics).not.toHaveBeenCalled();
  });

  it('returns warning and recovery guidance when collection has not produced metrics yet', async () => {
    instanceService.getInstanceById.mockResolvedValue({ id: 1, name: 'db-1', db_type: 'mysql' });
    metricsService.getRealtimeMetricsWithStatus.mockResolvedValue({ available: true, data: null, errorCode: 'METRICS_NOT_COLLECTED' });
    const result = await queryMetricsTool.handler({ instance_id: 1 });
    expect(result).toMatchObject({ success: true, status: 'warning', data: { metrics: null } });
    expect(result.next_actions?.length).toBeGreaterThan(0);
  });

  it('returns an error when metrics storage is unavailable instead of claiming no data', async () => {
    instanceService.getInstanceById.mockResolvedValue({ id: 1, name: 'db-1', db_type: 'mysql' });
    metricsService.getRealtimeMetricsWithStatus.mockResolvedValue({ available: false, data: null, errorCode: 'METRICS_STORAGE_UNAVAILABLE' });
    const result = await queryMetricsTool.handler({ instance_id: 1 });
    expect(result).toMatchObject({ success: false, status: 'error', errorCode: 'METRICS_STORAGE_UNAVAILABLE' });
  });

  it('rejects unknown metric IDs before querying storage', async () => {
    instanceService.getInstanceById.mockResolvedValue({ id: 1, name: 'db-1', db_type: 'mysql' });
    const result = await queryMetricsTool.handler({ instance_id: 1, metric_ids: ['not_a_real_metric'] });
    expect(result).toMatchObject({ success: false, errorCode: 'UNKNOWN_METRIC' });
    expect(metricsService.getRealtimeMetrics).not.toHaveBeenCalled();
  });
});
