import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  checkHealth: vi.fn(),
  checkConnectionAlive: vi.fn(),
  reconnect: vi.fn(),
  collectInstance: vi.fn(),
  getInstancePassword: vi.fn(),
  updateHealthStatus: vi.fn(),
  recordHealthCheck: vi.fn(),
  recordMetricAttempt: vi.fn(),
  clearInstance: vi.fn(),
  getPool: vi.fn(),
  scheduleList: vi.fn(),
  scheduleRecord: vi.fn(),
}));

vi.mock('./database-service.js', () => ({
  databaseService: {
    getConnection: mocks.getConnection,
    checkHealth: mocks.checkHealth,
    checkConnectionAlive: mocks.checkConnectionAlive,
    reconnect: mocks.reconnect,
  },
}));

vi.mock('./instance-database-service.js', () => ({
  instanceDatabaseService: {
    getInstancePassword: mocks.getInstancePassword,
    updateHealthStatus: mocks.updateHealthStatus,
    recordHealthCheck: mocks.recordHealthCheck,
    getAllInstances: vi.fn(),
  },
}));

vi.mock('./collector.js', () => ({
  unifiedCollector: { collectInstance: mocks.collectInstance },
}));

vi.mock('./metric-registry.js', () => ({
  metricRegistry: { getByDbType: vi.fn(() => []) },
}));

vi.mock('./collection-capabilities.js', () => ({
  collectionCapabilityTracker: {
    recordMetricAttempt: mocks.recordMetricAttempt,
    clearInstance: mocks.clearInstance,
  },
}));

vi.mock('./server-collector.js', () => ({
  default: { start: vi.fn(), stop: vi.fn() },
}));

vi.mock('./db-connection.js', () => ({
  dbConnection: { getPool: mocks.getPool },
}));

vi.mock('./collection-scheduler.js', () => ({
  MysqlCollectionScheduleStore: class {
    list = mocks.scheduleList;
    record = mocks.scheduleRecord;
  },
  dueStoredMetricIds: vi.fn(async () => []),
}));

import { monitorCollector } from './monitor-collector.js';

const collectMetrics = (instance: Record<string, unknown>) =>
  (monitorCollector as any).collectInstanceMetrics(instance, ['cpu_usage']);

describe('MonitorCollector credential-aware health state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnection.mockReturnValue(null);
    mocks.checkHealth.mockResolvedValue(null);
    mocks.checkConnectionAlive.mockResolvedValue(false);
    mocks.reconnect.mockResolvedValue(false);
    mocks.collectInstance.mockResolvedValue({});
    mocks.getInstancePassword.mockResolvedValue(null);
    mocks.updateHealthStatus.mockResolvedValue(undefined);
    mocks.recordHealthCheck.mockResolvedValue(undefined);
  });

  it('keeps an instance without credentials at unknown when no connection exists', async () => {
    const result = await collectMetrics({
      id: 101,
      name: 'pending-db',
      username: 'app',
      password_encrypted: '',
    });

    expect(result).toEqual({ cpu_usage: false });
    expect(mocks.collectInstance).not.toHaveBeenCalled();
    expect(mocks.checkHealth).not.toHaveBeenCalled();
    expect(mocks.clearInstance).toHaveBeenCalledWith(101);
    expect(mocks.updateHealthStatus).toHaveBeenCalledWith(101, 0, 'unknown');
  });

  it('does not report healthy when credentials are unavailable even if a stale connection object exists', async () => {
    mocks.getConnection.mockReturnValue({ connected: true, config: { user: 'app', password: 'secret' } });
    mocks.collectInstance.mockResolvedValue({ cpu_usage: true });
    mocks.checkHealth.mockResolvedValue({ health_score: 99, status: 'healthy', checks: [] });

    const result = await collectMetrics({
      id: 102,
      name: 'missing-credential-db',
      username: 'app',
      password_encrypted: 'ciphertext',
    });

    expect(result).toEqual({ cpu_usage: false });
    expect(mocks.collectInstance).not.toHaveBeenCalled();
    expect(mocks.checkHealth).not.toHaveBeenCalled();
    expect(mocks.updateHealthStatus).toHaveBeenCalledWith(102, 0, 'unknown');
  });

  it('keeps a configured instance critical when its connection probe fails', async () => {
    mocks.getInstancePassword.mockResolvedValue('secret');

    const result = await collectMetrics({
      id: 103,
      name: 'unreachable-db',
      username: 'app',
      password_encrypted: 'ciphertext',
    });

    expect(result).toEqual({ cpu_usage: false });
    expect(mocks.checkHealth).not.toHaveBeenCalled();
    expect(mocks.updateHealthStatus).toHaveBeenCalledWith(103, 0, 'critical');
  });

  it('keeps an instance unknown when credentials disappear during recovery', async () => {
    mocks.getInstancePassword
      .mockResolvedValueOnce('secret')
      .mockResolvedValue(null);
    mocks.collectInstance.mockRejectedValue(new Error('collector failure'));

    const result = await collectMetrics({
      id: 104,
      name: 'credentials-removed-during-collection',
      username: 'app',
      password_encrypted: 'ciphertext',
    });

    expect(result).toEqual({ cpu_usage: false });
    expect(mocks.clearInstance).toHaveBeenCalledWith(104);
    expect(mocks.updateHealthStatus).toHaveBeenLastCalledWith(104, 0, 'unknown');
    expect(mocks.updateHealthStatus).not.toHaveBeenCalledWith(104, 0, 'critical');
  });
});
