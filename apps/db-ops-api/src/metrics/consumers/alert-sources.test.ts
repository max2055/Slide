import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ evaluate: vi.fn(), execute: vi.fn(), create: vi.fn(), resolve: vi.fn(), rules: vi.fn() }));
vi.mock('../../db-connection.js', () => ({ dbConnection: { isConnected: () => true, getPool: () => ({ execute: m.execute }) } }));
vi.mock('../../server-database-service.js', () => ({ serverDatabaseService: { getCollectionEnabledServers: async () => [{ id: 7, label: 'server' }] } }));
vi.mock('./operational.js', () => ({ evaluateOperationalRule: m.evaluate }));
vi.mock('../../alert-database-service.js', () => ({ alertDatabaseService: {
  getAlertRules: m.rules, createAlert: m.create, resolveAlert: m.resolve,
  findActiveServerAlert: async () => null, findActiveNetworkDeviceAlert: async () => null,
  getActiveAlerts: async () => [],
} }));
import { serverAlertEvaluator } from '../../server-alert-evaluator.js';
import { NetworkDeviceAlertEvaluator } from '../../network-devices/network-device-alert-evaluator.js';

describe('production alerts use accepted semantic evidence without historical pre-reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.execute.mockRejectedValue(new Error('historical tables unavailable'));
    m.evaluate.mockResolvedValue({ handled: true, state: 'firing', level: 'error', value: 91,
      dimensions: {}, migration: { version: '1.0.0' }, observation: {
        observedAt: null, from: '2026-10-16T00:00:00.000Z', to: '2026-10-16T00:01:00.000Z', quality: 'partial',
      } });
  });
  it.each(['server', 'network_device'] as const)('%s alerts remain functional when historical tables cannot be read', async target => {
    m.rules.mockResolvedValue([{ id: 1, target_type: target, enabled: true, name: 'CPU', server_id: null,
      metric_name: target === 'server' ? 'cpu_usage' : 'device_cpu_percent', operator: '>', threshold: 80,
      threshold_template: { error: 80 }, duration_seconds: 60, severity: 'error' }]);
    const run = () => target === 'server' ? serverAlertEvaluator.evaluateServerRules()
      : new NetworkDeviceAlertEvaluator({ store: { getCollectionEnabledDevices: async () => [{ id: 7 }] } }).evaluate();
    await run();
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ metric_value: '91',
      tags: expect.objectContaining({ quality: 'partial', observed_from: '2026-10-16T00:00:00.000Z' }) }));
    expect(m.execute).not.toHaveBeenCalled();
    m.create.mockClear();
    m.evaluate.mockResolvedValue({ handled: true, state: 'unknown', level: null, value: null, recovery: false });
    await run();
    expect(m.create).not.toHaveBeenCalled(); expect(m.resolve).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });
  it('does not infer a sustained outage or recovery from an old server status', async () => {
    await serverAlertEvaluator.checkUnreachable();
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled(); expect(m.resolve).not.toHaveBeenCalled();
  });
});
