import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

vi.mock('../src/alert-rca-service', () => ({
  alertRCAService: { analyzeAlert: vi.fn().mockResolvedValue({ success: true }) },
}));

const mockPool = { execute: vi.fn().mockResolvedValue([[]]) };

describe('event-aggregator.ts', () => {
  beforeEach(() => { vi.resetModules(); vi.mocked(mockPool.execute).mockReset(); });

  it('aggregate returns 0 when no ungrouped alerts', async () => {
    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.aggregate();
    expect(result.eventsCreated).toBe(0);
    expect(result.alertsAggregated).toBe(0);
  });

  it('aggregate creates event when grouped alerts exist', async () => {
    vi.mocked(mockPool.execute)
      .mockResolvedValueOnce([[{
        instance_id: 1, alert_type: 'performance', metric_name: 'cpu_usage',
        time_bucket: 1234567800, alert_ids: '10,11,12', cnt: 3, max_level: 3,
      }]]) // grouping query
      .mockResolvedValueOnce([{ insertId: 100 }]) // insert event
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert member 10
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert member 11
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert member 12
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // insert log

    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.aggregate();
    expect(result.eventsCreated).toBe(1);
    expect(result.alertsAggregated).toBe(3);
  });

  it('getPendingAggregation returns list of pending alerts', async () => {
    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.getPendingAggregation();
    expect(Array.isArray(result)).toBe(true);
  });

  it('_levelToRank maps correctly', async () => {
    const { eventAggregator } = await import('../src/event-aggregator');
    expect((eventAggregator as any)._levelToRank('info')).toBe(1);
    expect((eventAggregator as any)._levelToRank('warning')).toBe(2);
    expect((eventAggregator as any)._levelToRank('error')).toBe(3);
    expect((eventAggregator as any)._levelToRank('critical')).toBe(4);
    expect((eventAggregator as any)._levelToRank('p0')).toBe(5);
  });
});
