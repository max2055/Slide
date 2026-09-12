import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllInstances: vi.fn(),
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
  getInstanceById: vi.fn(),
  getByDbType: vi.fn(() => []),
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
    getAllInstances: mocks.getAllInstances,
    getInstanceById: mocks.getInstanceById,
  },
}));

vi.mock('./collector.js', () => ({
  unifiedCollector: { collectInstance: mocks.collectInstance },
}));

vi.mock('./metric-registry.js', () => ({
  metricRegistry: { getByDbType: mocks.getByDbType },
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
    mocks.scheduleRecord.mockResolvedValue(undefined);
    mocks.getByDbType.mockReturnValue([]);
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

  it('collects an active instance immediately and advances its schedule', async () => {
    const instance = {
      id: 105,
      name: 'dm-ready',
      status: 'active',
      db_type: 'dameng',
      username: 'SYSDBA',
    };
    mocks.getInstanceById.mockResolvedValue(instance);
    mocks.getByDbType.mockReturnValue([
      { id: 'cpu_usage', default_interval: 30, is_collected: true },
      { id: 'health_score', default_interval: 30, is_collected: true },
    ]);
    mocks.getInstancePassword.mockResolvedValue('secret');
    mocks.getConnection.mockReturnValue({ connected: true });
    mocks.collectInstance.mockResolvedValue({ cpu_usage: true });
    mocks.checkHealth.mockResolvedValue({ health_score: 96, status: 'healthy', checks: [] });

    const result = await monitorCollector.collectInstanceNow(105);

    expect(mocks.collectInstance).toHaveBeenCalledWith(instance, ['cpu_usage']);
    expect(mocks.updateHealthStatus).toHaveBeenCalledWith(105, 96, 'healthy', undefined, undefined);
    expect(mocks.scheduleRecord).toHaveBeenCalledWith(
      'instance', 105, 'unified', expect.objectContaining({ id: 'cpu_usage' }), expect.any(Number), true,
    );
    expect(result).toMatchObject({
      instanceId: 105,
      attemptedMetricIds: ['cpu_usage'],
      succeededMetricIds: ['cpu_usage'],
    });
  });
});


describe('health scheduling without due metrics', () => {
  it('checks active instances with no registered metrics, independently every minute', async () => {
    vi.clearAllMocks();
    monitorCollector.stop();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100000);
    mocks.getAllInstances.mockResolvedValue([{ id: 201, status: 'active', db_type: 'dameng', username: 'app' }]);
    mocks.getByDbType.mockReturnValue([]);
    mocks.getInstancePassword.mockResolvedValue('secret');
    mocks.getConnection.mockReturnValue({ connected: true });
    mocks.checkHealth.mockResolvedValue({ health_score: 90, status: 'healthy', checks: [] });
    await (monitorCollector as any)._tick();
    expect(mocks.checkHealth).toHaveBeenCalledTimes(1);
    expect(mocks.updateHealthStatus).toHaveBeenCalledWith(201, 90, 'healthy', undefined, undefined);
    await (monitorCollector as any)._tick();
    expect(mocks.checkHealth).toHaveBeenCalledTimes(1);
    now.mockReturnValue(160000);
    await (monitorCollector as any)._tick();
    expect(mocks.checkHealth).toHaveBeenCalledTimes(2);
    expect(mocks.collectInstance).not.toHaveBeenCalled();
    now.mockRestore();
    monitorCollector.stop();
  });
});

it('marks an unexpected health collection error unknown rather than declaring an outage', async () => {
  vi.clearAllMocks();
  mocks.checkHealth.mockRejectedValue(new Error('query failed'));
  await (monitorCollector as any).updateHealthStatusFromCheck(301);
  expect(mocks.updateHealthStatus).toHaveBeenLastCalledWith(301, 0, 'unknown');
});
