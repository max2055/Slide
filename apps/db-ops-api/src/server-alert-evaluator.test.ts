import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getAlertRules: vi.fn(),
  getCollectionEnabledServers: vi.fn(),
  findActiveServerAlert: vi.fn(),
  createAlert: vi.fn(),
  touchAlert: vi.fn(),
  resolveAlert: vi.fn(),
  semantic: vi.fn(),
}));

vi.mock('./db-connection', () => ({
  dbConnection: {
    isConnected: () => true,
    getPool: () => ({ execute: mocks.execute }),
  },
}));

vi.mock('./server-database-service', () => ({
  serverDatabaseService: {
    getCollectionEnabledServers: mocks.getCollectionEnabledServers,
  },
}));

vi.mock('./alert-database-service', () => ({
  alertDatabaseService: {
    getAlertRules: mocks.getAlertRules,
    findActiveServerAlert: mocks.findActiveServerAlert,
    createAlert: mocks.createAlert,
    touchAlert: mocks.touchAlert,
    resolveAlert: mocks.resolveAlert,
  },
}));

vi.mock('./metrics-v2/consumers/operational.js', () => ({ evaluateOperationalRule: mocks.semantic }));

import { serverAlertEvaluator } from './server-alert-evaluator';

describe('ServerAlertEvaluator rule contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.semantic.mockResolvedValue({ handled: false, migration: null });
    mocks.getCollectionEnabledServers.mockResolvedValue([
      { id: 7, label: 'server-7', host: '127.0.0.1' },
    ]);
    mocks.findActiveServerAlert.mockResolvedValue(null);
    mocks.createAlert.mockResolvedValue({ success: true });
    mocks.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('INNER JOIN')) {
        return [[{ server_id: 7, metric_name: 'cpu_usage', metric_value: 91, recorded_at: new Date() }]];
      }
      if (sql.startsWith('SELECT metric_value FROM server_metrics')) {
        return [[{ metric_value: 90 }, { metric_value: 91 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it('requires semantic recovery evidence for the separate recovery duration', async () => {
    mocks.getAlertRules.mockResolvedValue([{ id: 2, name: 'CPU', target_type: 'server', metric_name: 'cpu_usage',
      operator: '>', threshold: 80, severity: 'warning', duration_seconds: 60, recovery_seconds: 120, server_id: null }]);
    mocks.findActiveServerAlert.mockResolvedValue({ id: 99 });
    mocks.semantic.mockResolvedValue({ handled: true, level: null, value: null, recovery: false, state: 'unknown' });
    await serverAlertEvaluator.evaluateServerRules(); expect(mocks.resolveAlert).not.toHaveBeenCalled();
    mocks.semantic.mockResolvedValue({ handled: true, level: null, value: 20, recovery: true, state: 'healthy' });
    await serverAlertEvaluator.evaluateServerRules(); expect(mocks.resolveAlert).toHaveBeenCalledWith(99);
    expect(mocks.semantic.mock.calls.some(c => c[2] === 120)).toBe(true);
  });

  it('uses only server rules and persists the multi-level result after duration is met', async () => {
    mocks.getAlertRules.mockResolvedValue([
      {
        id: 1, name: 'Instance CPU', target_type: 'instance', metric_name: 'cpu_usage',
        operator: '>=', threshold: 10, severity: 'critical', duration_seconds: 0, enabled: true,
      },
      {
        id: 2, name: 'Server CPU', target_type: 'server', metric_name: 'cpu_usage',
        operator: '>=', threshold: 80,
        threshold_template: { warning: 80, error: 90, critical: 95 },
        severity: 'warning', duration_seconds: 60, silence_minutes: 0, enabled: true,
        server_id: null,
      },
    ]);

    await serverAlertEvaluator.evaluateServerRules();

    expect(mocks.createAlert).toHaveBeenCalledTimes(1);
    expect(mocks.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      server_id: 7,
      metric_name: 'cpu_usage',
      level: 'error',
      tags: expect.objectContaining({ rule_id: 2, target_type: 'server' }),
    }));
  });

  it('does not create an alert when the duration window contains a healthy sample', async () => {
    mocks.getAlertRules.mockResolvedValue([{
      id: 2, name: 'Server CPU', target_type: 'server', metric_name: 'cpu_usage',
      operator: '>=', threshold: 80, severity: 'warning',
      duration_seconds: 60, silence_minutes: 0, enabled: true, server_id: null,
    }]);
    mocks.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('INNER JOIN')) {
        return [[{ server_id: 7, metric_name: 'cpu_usage', metric_value: 91, recorded_at: new Date() }]];
      }
      if (sql.startsWith('SELECT metric_value FROM server_metrics')) {
        return [[{ metric_value: 70 }, { metric_value: 91 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await serverAlertEvaluator.evaluateServerRules();

    expect(mocks.createAlert).not.toHaveBeenCalled();
  });
});
