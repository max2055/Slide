import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  collectInstance: vi.fn(),
  getConnection: vi.fn(),
  getInstancePassword: vi.fn(),
  reconnect: vi.fn(),
  recordMetricAttempt: vi.fn(),
  updateHealthStatus: vi.fn(),
}));

vi.mock('./database-service', () => ({
  databaseService: {
    checkConnectionAlive: vi.fn(),
    checkHealth: mocks.checkHealth,
    getConnection: mocks.getConnection,
    reconnect: mocks.reconnect,
  },
}));
vi.mock('./metrics-database-service', () => ({ metricsDatabaseService: {} }));
vi.mock('./instance-database-service', () => ({
  instanceDatabaseService: {
    getInstancePassword: mocks.getInstancePassword,
    updateHealthStatus: mocks.updateHealthStatus,
  },
}));
vi.mock('./metric-registry', () => ({ metricRegistry: { getByDbType: vi.fn() } }));
vi.mock('./collection-capabilities', () => ({
  collectionCapabilityTracker: { recordMetricAttempt: mocks.recordMetricAttempt },
}));
vi.mock('./collector', () => ({ unifiedCollector: { collectInstance: mocks.collectInstance } }));
vi.mock('./server-collector', () => ({ default: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: vi.fn() } }));

import { monitorCollector } from './monitor-collector';

type TestableMonitorCollector = {
  collectInstanceMetrics(instance: Record<string, unknown>, dueMetricIds: readonly string[]): Promise<Record<string, boolean>>;
};

describe('monitor collector credential recovery', () => {
  const instance = {
    id: 42,
    name: 'agent-created-db',
    db_type: 'mysql',
    host: 'db.internal',
    port: 3306,
    username: 'slide',
    database_name: 'app',
  };
  const collector = monitorCollector as unknown as TestableMonitorCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnection.mockReturnValue(null);
  });

  it('starts collecting after a missing credential is added later', async () => {
    mocks.reconnect.mockResolvedValue(false);
    mocks.getInstancePassword.mockResolvedValue('');

    await expect(collector.collectInstanceMetrics(instance, ['cpu_usage']))
      .resolves.toEqual({ cpu_usage: false });
    expect(mocks.collectInstance).not.toHaveBeenCalled();

    mocks.reconnect
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.getInstancePassword.mockResolvedValue('new-secret');
    mocks.collectInstance.mockResolvedValue({ cpu_usage: true });
    mocks.checkHealth.mockResolvedValue(null);

    await expect(collector.collectInstanceMetrics(instance, ['cpu_usage']))
      .resolves.toEqual({ cpu_usage: true });

    expect(mocks.reconnect).toHaveBeenNthCalledWith(1, 42);
    expect(mocks.reconnect).toHaveBeenNthCalledWith(2, 42, 'agent-created-db', {
      host: 'db.internal',
      port: 3306,
      user: 'slide',
      password: 'new-secret',
      database: 'app',
      db_type: 'mysql',
    });
    expect(mocks.collectInstance).toHaveBeenCalledWith(instance, ['cpu_usage']);
    expect(mocks.recordMetricAttempt).toHaveBeenLastCalledWith(42, 'cpu_usage', true);
  });
});
