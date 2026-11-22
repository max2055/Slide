import { describe, it, expect, vi, beforeEach } from 'vitest';

const formal = vi.hoisted(() => vi.fn());
vi.mock('../src/metrics/consumers/operational.js', () => ({ evaluateOperationalRule: formal }));

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => null, isConnected: () => false },
}));

vi.mock('../src/instance-database-service', () => ({
  instanceDatabaseService: {
    getAllInstances: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/alert-database-service', () => ({
  alertDatabaseService: { getAlertRules: vi.fn().mockResolvedValue([]) },
  AlertRule: class {},
}));

describe('alert-evaluator.ts', () => {
  beforeEach(() => { vi.resetModules(); formal.mockReset(); formal.mockResolvedValue({ handled: true, state: 'unknown', level: null, value: null, recovery: false }); });

  it('evaluateAllRules: uses dynamic instance discovery', async () => {
    const { instanceDatabaseService } = await import('../src/instance-database-service');
    const { alertDatabaseService } = await import('../src/alert-database-service');
    const { evaluateAllRules } = await import('../src/alert-evaluator');

    vi.mocked(alertDatabaseService.getAlertRules).mockResolvedValue([
      { id: 1, name: 'High CPU', metric_name: 'cpu_usage', operator: '>', threshold: 80, duration_seconds: 0, severity: 'warning', enabled: true },
    ]);
    vi.mocked(instanceDatabaseService.getAllInstances).mockResolvedValue([
      { id: 10, name: 'prod-mysql-01' },
      { id: 20, name: 'prod-pg-01' },
    ] as any);

    formal.mockResolvedValue({handled: true, state: 'firing', level: 'warning', value: 95});
    const result = await evaluateAllRules();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].instanceId).toBe(10);
    expect(result[0].instanceName).toBe('prod-mysql-01');
  });

  it('evaluateAllRules: ignores a server rule with the same metric name', async () => {
    const { instanceDatabaseService } = await import('../src/instance-database-service');
    const { alertDatabaseService } = await import('../src/alert-database-service');
    const { evaluateAllRules } = await import('../src/alert-evaluator');

    vi.mocked(alertDatabaseService.getAlertRules).mockResolvedValue([
      { id: 1, name: 'Instance CPU', target_type: 'instance', metric_name: 'cpu_usage', operator: '>', threshold: 80, duration_seconds: 0, severity: 'warning', enabled: true },
      { id: 2, name: 'Server CPU', target_type: 'server', metric_name: 'cpu_usage', operator: '>', threshold: 10, duration_seconds: 0, severity: 'critical', enabled: true },
    ] as any);
    vi.mocked(instanceDatabaseService.getAllInstances).mockResolvedValue([
      { id: 10, name: 'prod-mysql-01', db_type: 'mysql' },
    ] as any);

    expect(await evaluateAllRules()).toEqual([]);
    expect(formal).toHaveBeenCalledExactlyOnceWith(
      { type: 'instance', id: 10 }, expect.objectContaining({ target_type: 'instance' }), 0, expect.any(Object),
    );
  });

  it('evaluateAllRules: returns empty when no rules', async () => {
    const { alertDatabaseService } = await import('../src/alert-database-service');
    const { evaluateAllRules } = await import('../src/alert-evaluator');
    vi.mocked(alertDatabaseService.getAlertRules).mockResolvedValue([]);
    const result = await evaluateAllRules();
    expect(result).toEqual([]);
  });
});
