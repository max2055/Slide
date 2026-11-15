import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkDeviceAlertEvaluator } from './network-device-alert-evaluator.js';
import { workflowExecution } from '../workflows/execution-context.js';

const mocks = vi.hoisted(() => ({
  semantic: vi.fn(), getAlertRules: vi.fn(), findActiveNetworkDeviceAlert: vi.fn(),
  createAlert: vi.fn(), touchAlert: vi.fn(), getActiveAlerts: vi.fn(), resolveAlert: vi.fn(),
}));
vi.mock('../metrics/consumers/operational.js', () => ({ evaluateOperationalRule: mocks.semantic }));
vi.mock('../alert-database-service.js', () => ({ alertDatabaseService: mocks }));

const rule = { id: 11, name: 'CPU', target_type: 'network_device', metric_name: 'device_cpu_percent',
  operator: '>=', threshold: 80, duration_seconds: 0, severity: 'warning', enabled: true };
const firing = { handled: true, state: 'firing', value: 92, level: 'warning', dimensions: { if_index: '1' } };
const devices = [{ id: 1 }, { id: 2 }];
const evaluator = () => new NetworkDeviceAlertEvaluator({ store: { getCollectionEnabledDevices: async () => devices } });
const active = (id: number) => ({ id, target_type: 'network_device', network_device_id: id,
  metric_name: rule.metric_name, tags: { rule_id: rule.id } });

describe('MAX-567 / #340 #539 formal network evaluation failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getAlertRules.mockResolvedValue([rule]);
    mocks.semantic.mockResolvedValue(firing);
    mocks.findActiveNetworkDeviceAlert.mockResolvedValue(null);
    mocks.createAlert.mockResolvedValue({ success: true });
    mocks.getActiveAlerts.mockResolvedValue([]);
    mocks.resolveAlert.mockResolvedValue({ success: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('continues later rules and devices after the first semantic query fails', async () => {
    mocks.getAlertRules.mockResolvedValue([rule, { ...rule, id: 12 }]);
    mocks.semantic.mockRejectedValueOnce(new Error('QUERY_FAILED'));
    expect(await evaluator().evaluate()).toMatchObject({
      status: 'partial', failed: 1, evaluated: 3, matched: 3, triggered: 3,
      failures: [{ phase: 'evaluation', deviceId: 1, ruleId: 11 }],
    });
    expect(mocks.semantic).toHaveBeenCalledTimes(4);
    expect(mocks.semantic.mock.calls[0].at(-1)).toBe(true);
  });

  it.each(['create', 'dedup', 'touch'])('does not count a failed %s as persisted; next cycle recovers', async phase => {
    if (phase === 'create') mocks.createAlert.mockResolvedValueOnce({ success: false });
    if (phase === 'dedup') mocks.findActiveNetworkDeviceAlert.mockRejectedValueOnce(new Error('READ_FAILED'));
    if (phase === 'touch') {
      mocks.findActiveNetworkDeviceAlert.mockResolvedValueOnce({ id: 1 });
      mocks.touchAlert.mockRejectedValueOnce(new Error('UPDATE_FAILED'));
    }
    expect(await evaluator().evaluate()).toMatchObject({ status: 'partial', matched: 2, triggered: 1, failed: 1 });
    expect(await evaluator().evaluate()).toMatchObject({ status: 'complete', matched: 2, triggered: 2, failed: 0 });
  });

  it('reports a setup failure without treating an empty cycle as successful', async () => {
    mocks.getAlertRules.mockRejectedValueOnce(new Error('RULES_FAILED'));
    expect(await evaluator().evaluate()).toMatchObject({ status: 'failed', failed: 1, evaluated: 0 });
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it('isolates recovery failures and reports failed resolve results', async () => {
    mocks.semantic.mockResolvedValue({ handled: true, state: 'healthy', level: null, value: 40, recovery: true })
      .mockResolvedValueOnce({ handled: true, state: 'unknown', value: null })
      .mockResolvedValueOnce({ handled: true, state: 'unknown', value: null });
    mocks.getActiveAlerts.mockResolvedValue([active(1), active(2)]);
    mocks.resolveAlert.mockResolvedValueOnce({ success: false });
    expect(await evaluator().evaluate()).toMatchObject({ status: 'partial', failed: 1 });
    expect(mocks.resolveAlert.mock.calls).toEqual([[1], [2]]);
  });

  it('continues recovery queries after one alert query fails', async () => {
    mocks.semantic.mockResolvedValue({ handled: true, state: 'unknown', value: null })
      .mockResolvedValueOnce({ handled: true, state: 'unknown', value: null })
      .mockResolvedValueOnce({ handled: true, state: 'unknown', value: null })
      .mockRejectedValueOnce(new Error('RECOVERY_QUERY_FAILED'))
      .mockResolvedValueOnce({ handled: true, state: 'healthy', level: null, value: 40, recovery: true });
    mocks.getActiveAlerts.mockResolvedValue([active(1), active(2)]);
    expect(await evaluator().evaluate()).toMatchObject({ status: 'partial', failed: 1 });
    expect(mocks.resolveAlert.mock.calls).toEqual([[2]]);
  });

  it('propagates cancellation even when the rule query returns no rules', async () => {
    const controller = new AbortController();
    const cancel = new Error('CANCELLED');
    mocks.getAlertRules.mockImplementation(async () => { controller.abort(cancel); return []; });
    await expect(workflowExecution.run({ signal: controller.signal } as any, () => evaluator().evaluate())).rejects.toBe(cancel);
  });

  it.each(['unknown', 'stale', 'invalid'])('never triggers or recovers from %s evidence', async state => {
    mocks.semantic.mockResolvedValue({ handled: true, state, value: null, recovery: false });
    mocks.getActiveAlerts.mockResolvedValue([active(1)]);
    expect(await evaluator().evaluate()).toMatchObject({ triggered: 0, skipped: 2, failed: 0 });
    expect(mocks.createAlert).not.toHaveBeenCalled();
    expect(mocks.resolveAlert).not.toHaveBeenCalled();
  });

  it('does not widen malformed recovery dimensions to a whole-device query', async () => {
    mocks.semantic.mockResolvedValue({ handled: true, state: 'unknown', value: null });
    mocks.getActiveAlerts.mockResolvedValue([{ ...active(1), tags: { rule_id: 11, dimensions: '{bad' } }]);
    expect(await evaluator().evaluate()).toMatchObject({ status: 'partial', failed: 1 });
    expect(mocks.semantic).toHaveBeenCalledTimes(2);
    expect(mocks.resolveAlert).not.toHaveBeenCalled();
  });

  it.each(['evaluation', 'recovery'])('propagates cancellation during %s', async phase => {
    const controller = new AbortController();
    const cancel = new Error('CANCELLED');
    if (phase === 'recovery') {
      mocks.semantic.mockResolvedValue({ handled: true, state: 'unknown', value: null });
      mocks.getActiveAlerts.mockImplementation(async () => { controller.abort(cancel); throw cancel; });
    }
    else mocks.semantic.mockImplementation(async () => { controller.abort(cancel); throw cancel; });
    await expect(workflowExecution.run({ signal: controller.signal } as any, () => evaluator().evaluate())).rejects.toBe(cancel);
    expect(mocks.createAlert).not.toHaveBeenCalled();
    expect(mocks.resolveAlert).not.toHaveBeenCalled();
  });
});
