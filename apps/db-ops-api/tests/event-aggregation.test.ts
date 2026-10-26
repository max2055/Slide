import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

vi.mock('../src/alert-rca-service', () => ({
  alertRCAService: { analyzeAlert: vi.fn().mockResolvedValue({ success: true }) },
}));

// Admission recovery reads persisted alerts with pool.query; aggregation uses
// pool.execute. Both dependencies are part of the aggregator's real contract.
const mockPool = {
  execute: vi.fn().mockResolvedValue([[]]),
  query: vi.fn().mockResolvedValue([[]]),
};

const alert = (id: number, minutesAgo: number, level = 'critical') => ({
  id, instance_id: 1, alert_type: 'performance', metric_name: 'cpu_usage', level,
  created_at: new Date(Date.now() - minutesAgo * 60_000),
});
const sqlOf = (call: any[]) => String(call[0]);
const inserts = (table: string) => mockPool.execute.mock.calls.filter(call => sqlOf(call).includes(`INSERT INTO ${table}`));

describe('event-aggregator.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPool.execute.mockReset().mockResolvedValue([[]]);
    mockPool.query.mockReset().mockResolvedValue([[]]);
  });

  it('aggregate returns 0 when no ungrouped alerts', async () => {
    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.aggregate();
    expect(result.eventsCreated).toBe(0);
    expect(result.alertsAggregated).toBe(0);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('investigation_alert_owners'));
  });

  it('aggregate creates one event and links every alert in a window', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]])                       // existing events
      .mockResolvedValueOnce([[alert(10, 3), alert(11, 2), alert(12, 1)]]) // ungrouped alerts
      .mockResolvedValueOnce([{ insertId: 77 }]);        // INSERT alert_events

    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.aggregate();

    expect(result).toEqual({ eventsCreated: 1, alertsAggregated: 3 });
    expect(inserts('alert_events')).toHaveLength(1);
    expect(inserts('alert_events')[0][1]).toEqual([
      expect.any(String), '告警事件: performance on Instance 1',
      '同实例同类型告警自动聚合 (3 条)', 1, 'performance', 'critical',
    ]);
    expect(inserts('alert_event_members').map(call => call[1])).toEqual([
      [77, 10], [77, 11], [77, 12],
    ]);
    expect(inserts('alert_event_members').map(sqlOf)).toEqual(
      Array(3).fill(expect.stringContaining("VALUES (?, ?, 'triggered')")),
    );
    expect(inserts('alert_event_logs')).toHaveLength(1);
    expect(JSON.parse(String(inserts('alert_event_logs')[0][1][1]))).toMatchObject({
      alert_count: 3, alert_ids: [10, 11, 12], action: 'created',
    });
  });

  it('keeps a single alert ungrouped without creating a display event', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[alert(10, 1)]]);

    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.aggregate();

    expect(result).toEqual({ eventsCreated: 0, alertsAggregated: 0 });
    expect(inserts('alert_events')).toHaveLength(0);
    expect(inserts('alert_event_members')).toHaveLength(0);
  });

  it('aggregates even when admission recovery fails', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('recovery sweep unavailable'));
    mockPool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[alert(10, 2), alert(11, 1)]])
      .mockResolvedValueOnce([{ insertId: 88 }]);

    const { eventAggregator } = await import('../src/event-aggregator');
    const result = await eventAggregator.aggregate();

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ eventsCreated: 1, alertsAggregated: 2 });
    expect(inserts('alert_event_members')).toHaveLength(2);
  });

  it('getPendingAggregation returns list of pending alerts', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);
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
