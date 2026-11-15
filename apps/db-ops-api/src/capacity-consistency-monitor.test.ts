import { describe, expect, it, vi } from 'vitest';
import { CapacityConsistencyMonitor, createCapacityConsistencyJob } from './capacity-consistency-monitor.js';
import type { ConsistencyCheck } from './consistency-checker.js';

function recoveredMonitor(ids = [41, 42, 43]) {
  const check: ConsistencyCheck = Object.freeze({ id: 'capacity_sum_match', label: '容量数据一致性', category: 'capacity', status: 'pass', severity: 'info', summary: 'ok' });
  const execute = vi.fn().mockResolvedValue([ids.map(id => ({ id }))]);
  const checker = { _checkCapacitySumMatch: vi.fn().mockResolvedValue(check) };
  const createAlert = vi.fn();
  const resolveAlert = vi.fn().mockResolvedValue({ success: true });
  return { monitor: new CapacityConsistencyMonitor(() => ({ execute }), checker, { createAlert, resolveAlert }), check, checker, execute, createAlert, resolveAlert };
}

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

  it('OCR-0738: returns the unchanged pass after every active alert is resolved', async () => {
    const h = recoveredMonitor();
    await expect(h.monitor.runOnce()).resolves.toBe(h.check);
    expect(h.resolveAlert.mock.calls).toEqual([[41], [42], [43]]);
    expect(h.createAlert).not.toHaveBeenCalled();
  });

  it('OCR-0738: reports every failed resolution while still resolving other alerts', async () => {
    const h = recoveredMonitor();
    h.resolveAlert.mockResolvedValueOnce({ success: false, error: 'LOCAL_FIXTURE_UPDATE_FAILED' })
      .mockRejectedValueOnce(new Error('TRANSPORT_FAILED'));
    const error = await h.monitor.runOnce().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain('CAPACITY_CONSISTENCY_ALERT_RESOLVE_FAILED:41:LOCAL_FIXTURE_UPDATE_FAILED');
    expect(error.message).toContain('CAPACITY_CONSISTENCY_ALERT_RESOLVE_FAILED:42:TRANSPORT_FAILED');
    expect(error.errors).toHaveLength(2);
    expect(h.resolveAlert.mock.calls).toEqual([[41], [42], [43]]);
    expect(h.check.status).toBe('pass');
    expect(h.createAlert).not.toHaveBeenCalled();
  });

  it('OCR-0738: rejects an unsuccessful resolution even without an error message', async () => {
    const h = recoveredMonitor([41]);
    h.resolveAlert.mockResolvedValueOnce({ success: false });
    await expect(h.monitor.runOnce()).rejects.toThrow('CAPACITY_CONSISTENCY_ALERT_RESOLVE_FAILED:41');
  });

  it('OCR-0738: retries only remaining active alerts and tolerates an already resolved race', async () => {
    const h = recoveredMonitor([41, 42]);
    h.resolveAlert.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: 'UPDATE_FAILED' });
    await expect(h.monitor.runOnce()).rejects.toThrow('UPDATE_FAILED');
    // The service returns success for an alert another worker has already resolved.
    h.execute.mockResolvedValueOnce([[{ id: 42 }]]).mockResolvedValueOnce([[]]);
    await expect(h.monitor.runOnce()).resolves.toBe(h.check);
    await expect(h.monitor.runOnce()).resolves.toBe(h.check);
    expect(h.resolveAlert.mock.calls).toEqual([[41], [42], [42]]);
  });

  it('OCR-0738: performs no work when already cancelled', async () => {
    const h = recoveredMonitor();
    const controller = new AbortController();
    const reason = new Error('CANCELLED');
    controller.abort(reason);
    await expect(h.monitor.runOnce(controller.signal)).rejects.toBe(reason);
    expect(h.checker._checkCapacitySumMatch).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.resolveAlert).not.toHaveBeenCalled();
  });

  it.each([true, false])('OCR-0738: stops after an in-flight resolution settles on cancellation (success=%s)', async (success) => {
    const h = recoveredMonitor();
    const controller = new AbortController();
    const reason = new Error('CANCELLED_DURING_RESOLUTION');
    h.resolveAlert.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { success };
    });
    await expect(h.monitor.runOnce(controller.signal)).rejects.toBe(reason);
    expect(h.resolveAlert.mock.calls).toEqual([[41]]);
    expect(h.check.status).toBe('pass');
  });
});
