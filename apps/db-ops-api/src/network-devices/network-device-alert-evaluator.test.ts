import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NetworkDeviceAlertEvaluator,
  type NetworkDeviceAlertObservation,
  type NetworkDeviceAlertStore,
} from './network-device-alert-evaluator.js';

const device = { id: 7, name: 'edge-1', label: 'edge-1', status: 'online', collectionEnabled: true };

function observation(metricId: string, value: number | null, dimensions?: Record<string, string>, quality: NetworkDeviceAlertObservation['quality'] = 'good'): NetworkDeviceAlertObservation {
  return {
    metricId,
    value,
    dimensions,
    quality,
    observedAt: new Date('2026-08-26T00:00:00.000Z'),
    validUntil: new Date('2026-08-26T00:05:00.000Z'),
  };
}

const mocks = vi.hoisted(() => ({
  getAlertRules: vi.fn(),
  findActiveNetworkDeviceAlert: vi.fn(),
  createAlert: vi.fn(),
  touchAlert: vi.fn(),
  getActiveAlerts: vi.fn(),
  resolveAlert: vi.fn(),
}));

vi.mock('../alert-database-service.js', () => ({
  alertDatabaseService: {
    getAlertRules: mocks.getAlertRules,
    findActiveNetworkDeviceAlert: mocks.findActiveNetworkDeviceAlert,
    createAlert: mocks.createAlert,
    touchAlert: mocks.touchAlert,
    getActiveAlerts: mocks.getActiveAlerts,
    resolveAlert: mocks.resolveAlert,
  },
}));

function store(overrides: Partial<NetworkDeviceAlertStore> = {}): NetworkDeviceAlertStore {
  return {
    getCollectionEnabledDevices: vi.fn(async () => [device]),
    getLatestObservations: vi.fn(async () => [observation('device_cpu_percent', 92)]),
    getObservationHistory: vi.fn(async () => [observation('device_cpu_percent', 91), observation('device_cpu_percent', 92)]),
    ...overrides,
  };
}

describe('NetworkDeviceAlertEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAlertRules.mockResolvedValue([
      {
        id: 11,
        name: '设备 CPU',
        target_type: 'network_device',
        network_device_id: null,
        metric_name: 'device_cpu_percent',
        operator: '>=',
        threshold: 80,
        threshold_template: { warning: 80, error: 90, critical: 95 },
        duration_seconds: 60,
        severity: 'warning',
        silence_minutes: 5,
        enabled: true,
      },
    ]);
    mocks.findActiveNetworkDeviceAlert.mockResolvedValue(null);
    mocks.createAlert.mockResolvedValue({ success: true, alertId: 101 });
    mocks.getActiveAlerts.mockResolvedValue([]);
    mocks.resolveAlert.mockResolvedValue({ success: true });
  });

  it('evaluates network rules and persists a device-targeted alert', async () => {
    const evaluator = new NetworkDeviceAlertEvaluator({ store: store(), clock: () => new Date('2026-08-26T00:01:00.000Z') });

    await expect(evaluator.evaluateNetworkDeviceRules()).resolves.toMatchObject({ evaluated: 1, triggered: 1 });
    expect(mocks.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      network_device_id: 7,
      target_type: 'network_device',
      metric_name: 'device_cpu_percent',
      level: 'error',
    }));
  });

  it('keeps interface dimensions on the deduplication and alert payload', async () => {
    mocks.getAlertRules.mockResolvedValue([{
      id: 12, name: '接口 down', target_type: 'network_device', network_device_id: 7,
      metric_name: 'interface_oper_status', operator: '=', threshold: 0,
      threshold_template: { warning: 0, error: 0, critical: 0 }, duration_seconds: 0,
      severity: 'critical', silence_minutes: 0, enabled: true,
    }]);
    const evaluator = new NetworkDeviceAlertEvaluator({
      store: store({ getLatestObservations: vi.fn(async () => [observation('interface_oper_status', 0, { if_index: '3', interface: 'GE0/0/3' })]) }),
      clock: () => new Date('2026-08-26T00:01:00.000Z'),
    });

    await evaluator.evaluateNetworkDeviceRules();

    expect(mocks.findActiveNetworkDeviceAlert).toHaveBeenCalledWith(7, 'interface_oper_status', 12, { if_index: '3', interface: 'GE0/0/3' });
    expect(mocks.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      network_device_id: 7,
      tags: expect.objectContaining({ dimensions: { if_index: '3', interface: 'GE0/0/3' } }),
    }));
  });

  it('does not alert on unknown, stale, or non-finite observations', async () => {
    const evaluator = new NetworkDeviceAlertEvaluator({
      store: store({
        getLatestObservations: vi.fn(async () => [
          observation('device_cpu_percent', 99, undefined, 'unknown'),
          { ...observation('device_cpu_percent', 99), validUntil: new Date('2026-08-25T00:00:00.000Z') },
          observation('device_cpu_percent', Number.NaN),
        ]),
      }),
    });

    await expect(evaluator.evaluateNetworkDeviceRules()).resolves.toMatchObject({ evaluated: 0, triggered: 0 });
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it('fires a synthetic reachability alert after the collector marks a device unreachable', async () => {
    mocks.getAlertRules.mockResolvedValue([{
      id: 13, name: '设备不可达', target_type: 'network_device', network_device_id: 7,
      metric_name: 'device_reachability', operator: '=', threshold: 0,
      threshold_template: { warning: 0, error: 0, critical: 0 }, duration_seconds: 600,
      severity: 'error', silence_minutes: 5, enabled: true,
    }]);
    const evaluator = new NetworkDeviceAlertEvaluator({
      store: store({ getCollectionEnabledDevices: vi.fn(async () => [{ ...device, status: 'unreachable' }]), getLatestObservations: vi.fn(async () => []) }),
      clock: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    await expect(evaluator.evaluateNetworkDeviceRules()).resolves.toMatchObject({ evaluated: 1, triggered: 1 });
    expect(mocks.createAlert).toHaveBeenCalledWith(expect.objectContaining({ metric_name: 'device_reachability', network_device_id: 7, level: 'error' }));
  });

  it('requires fresh historical samples to satisfy a duration window', async () => {
    const now = new Date('2026-08-26T00:02:00.000Z');
    mocks.getAlertRules.mockResolvedValue([{
      id: 11, name: '设备 CPU', target_type: 'network_device', network_device_id: null,
      metric_name: 'device_cpu_percent', operator: '>=', threshold: 80,
      threshold_template: { warning: 80, error: 90, critical: 95 }, duration_seconds: 120,
      severity: 'warning', silence_minutes: 5, enabled: true,
    }]);
    const current = { ...observation('device_cpu_percent', 92), observedAt: now, validUntil: new Date(now.getTime() + 300_000) };
    const history = [
      { ...current, observedAt: new Date('2026-08-26T00:00:00.000Z'), validUntil: new Date('2026-08-26T00:05:00.000Z') },
      { ...current, observedAt: new Date('2026-08-26T00:01:00.000Z'), validUntil: new Date('2026-08-26T00:05:30.000Z') },
    ];
    const evaluator = new NetworkDeviceAlertEvaluator({ store: store({
      getLatestObservations: vi.fn(async () => [current]),
      getObservationHistory: vi.fn(async () => history),
    }), clock: () => now });
    await expect(evaluator.evaluateNetworkDeviceRules()).resolves.toMatchObject({ evaluated: 1, triggered: 1 });

    const staleEvaluator = new NetworkDeviceAlertEvaluator({ store: store({
      getLatestObservations: vi.fn(async () => [current]),
      getObservationHistory: vi.fn(async () => history.map((sample) => ({ ...sample, validUntil: new Date('2026-08-26T00:01:00.000Z') }))),
    }), clock: () => now });
    await expect(staleEvaluator.evaluateNetworkDeviceRules()).resolves.toMatchObject({ evaluated: 1, triggered: 0 });
  });

  it('resolves a device alert only after fresh evidence no longer matches', async () => {
    mocks.getActiveAlerts.mockResolvedValue([{
      id: 55, target_type: 'network_device', network_device_id: 7, metric_name: 'device_cpu_percent',
      tags: { rule_id: 11 }, status: 'read',
    }]);
    const evaluator = new NetworkDeviceAlertEvaluator({ store: store({
      getLatestObservations: vi.fn(async () => [observation('device_cpu_percent', 40)]),
    }), clock: () => new Date('2026-08-26T00:01:00.000Z') });
    await evaluator.evaluateNetworkDeviceRules();
    expect(mocks.resolveAlert).toHaveBeenCalledWith(55);
  });

  it('evaluates only the latest sample for each metric and dimension set', async () => {
    const current = { ...observation('device_cpu_percent', 40), observedAt: new Date('2026-08-26T00:01:00.000Z') };
    const older = { ...current, value: 99, observedAt: new Date('2026-08-26T00:00:00.000Z') };
    const evaluator = new NetworkDeviceAlertEvaluator({ store: store({ getLatestObservations: vi.fn(async () => [older, current]) }), clock: () => new Date('2026-08-26T00:01:00.000Z') });
    await evaluator.evaluateNetworkDeviceRules();
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });
});
