import { describe, expect, it, vi } from 'vitest';
import { CapacityConsistencyMonitor, createCapacityConsistencyJob } from './capacity-consistency-monitor.js';

describe('CapacityConsistencyMonitor', () => {
  it('creates one deduplicated alert for persistent drift', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 41 }]]);
    const createAlert = vi.fn().mockResolvedValue({ success: true, alertId: 41 });
    const monitor = new CapacityConsistencyMonitor(
      () => ({ execute }),
      { _checkCapacitySumMatch: vi.fn().mockResolvedValue({ id: 'capacity_sum_match', label: '容量数据一致性', category: 'capacity', status: 'warn', severity: 'minor', summary: 'drift' }) },
      { createAlert, resolveAlert: vi.fn() },
    );

    await monitor.runOnce();
    await monitor.runOnce();

    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({ source: 'capacity-consistency-monitor', metric_name: 'capacity_sum_match' }));
  });

  it('resolves the active alert after consistency recovers', async () => {
    const resolveAlert = vi.fn().mockResolvedValue({ success: true });
    const monitor = new CapacityConsistencyMonitor(
      () => ({ execute: vi.fn().mockResolvedValue([[{ id: 41 }]]) }),
      { _checkCapacitySumMatch: vi.fn().mockResolvedValue({ id: 'capacity_sum_match', label: '容量数据一致性', category: 'capacity', status: 'pass', severity: 'info', summary: 'ok' }) },
      { createAlert: vi.fn(), resolveAlert },
    );

    await monitor.runOnce();

    expect(resolveAlert).toHaveBeenCalledWith(41);
  });

  it('uses stable five-minute workflow slots', () => {
    const job = createCapacityConsistencyJob(new Date('2026-07-22T00:04:59.999Z'));
    expect(job.id).toBe('capacity-consistency-5948928');
    expect(job.idempotencyKey).toBe('capacity-consistency:5948928');
  });
});
