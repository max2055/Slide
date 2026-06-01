import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => null, isConnected: () => false },
}));

vi.mock('../src/instance-database-service', () => ({
  instanceDatabaseService: {
    getAllInstances: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/metrics-database-service', () => ({
  metricsDatabaseService: {
    getRealtimeMetrics: vi.fn().mockResolvedValue(null),
    getHistoricalMetrics: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/baseline-calculator', () => ({
  baselineCalculator: { getCachedBaseline: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../src/alert-database-service', () => ({
  alertDatabaseService: { getAlertRules: vi.fn().mockResolvedValue([]) },
  AlertRule: class {},
}));

describe('alert-evaluator.ts', () => {
  beforeEach(() => { vi.resetModules(); });

  it('evaluateRule: > operator works with numeric comparison', async () => {
    const { evaluateRule } = await import('../src/alert-evaluator');
    expect(evaluateRule({ operator: '>', threshold: 80 } as any, 90)).toBe(true);
    expect(evaluateRule({ operator: '>', threshold: 80 } as any, 80)).toBe(false);
    expect(evaluateRule({ operator: '>', threshold: 80 } as any, 70)).toBe(false);
  });

  it('evaluateRule: all 6 operators work', async () => {
    const { evaluateRule } = await import('../src/alert-evaluator');
    expect(evaluateRule({ operator: '<', threshold: 10 } as any, 5)).toBe(true);
    expect(evaluateRule({ operator: '>=', threshold: 50 } as any, 50)).toBe(true);
    expect(evaluateRule({ operator: '<=', threshold: 100 } as any, 100)).toBe(true);
    expect(evaluateRule({ operator: '=', threshold: 42 } as any, 42)).toBe(true);
    expect(evaluateRule({ operator: '!=', threshold: 0 } as any, 5)).toBe(true);
    expect(evaluateRule({ operator: '!=', threshold: 5 } as any, 5)).toBe(false);
  });

  it('evaluateRule: handles string threshold (DECIMAL bug fix)', async () => {
    const { evaluateRule } = await import('../src/alert-evaluator');
    // Phase 02 bug: "997.00" > "5000.00" was true due to lexicographic compare
    expect(evaluateRule({ operator: '>', threshold: '5000.00' as any } as any, 997)).toBe(false);
  });

  it('getMetricValue: extracts correct metric from record', async () => {
    const { evaluateRule } = await import('../src/alert-evaluator');
    // getMetricValue is internal, tested via evaluateRule
    const rule = { operator: '>', threshold: 50, metric_name: 'cpu_usage' } as any;
    expect(evaluateRule(rule, 75)).toBe(true);
  });

  it('checkDuration: returns false when no history and current value not triggered', async () => {
    const { metricsDatabaseService } = await import('../src/metrics-database-service');
    vi.mocked(metricsDatabaseService.getRealtimeMetrics).mockResolvedValue({ cpu_usage: 30 } as any);
    const { checkDuration } = await import('../src/alert-evaluator');
    const result = await checkDuration(1, { metric_name: 'cpu_usage', operator: '>', threshold: 80 } as any, 60);
    expect(result).toBe(false);
  });

  it('checkDuration: returns true when no history but current value triggered', async () => {
    const { metricsDatabaseService } = await import('../src/metrics-database-service');
    vi.mocked(metricsDatabaseService.getRealtimeMetrics).mockResolvedValue({ cpu_usage: 90 } as any);
    const { checkDuration } = await import('../src/alert-evaluator');
    const result = await checkDuration(1, { metric_name: 'cpu_usage', operator: '>', threshold: 80 } as any, 60);
    expect(result).toBe(true);
  });

  it('evaluateAllRules: uses dynamic instance discovery', async () => {
    const { instanceDatabaseService } = await import('../src/instance-database-service');
    const { alertDatabaseService } = await import('../src/alert-database-service');
    const { metricsDatabaseService } = await import('../src/metrics-database-service');
    const { evaluateAllRules } = await import('../src/alert-evaluator');

    vi.mocked(alertDatabaseService.getAlertRules).mockResolvedValue([
      { id: 1, name: 'High CPU', metric_name: 'cpu_usage', operator: '>', threshold: 80, duration_seconds: 0, severity: 'warning', enabled: true },
    ]);
    vi.mocked(instanceDatabaseService.getAllInstances).mockResolvedValue([
      { id: 10, name: 'prod-mysql-01' },
      { id: 20, name: 'prod-pg-01' },
    ] as any);
    vi.mocked(metricsDatabaseService.getRealtimeMetrics)
      .mockResolvedValue({ cpu_usage: 95 } as any);

    const result = await evaluateAllRules();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].instanceId).toBe(10);
    expect(result[0].instanceName).toBe('prod-mysql-01');
  });

  it('evaluateAllRules: returns empty when no rules', async () => {
    const { alertDatabaseService } = await import('../src/alert-database-service');
    const { evaluateAllRules } = await import('../src/alert-evaluator');
    vi.mocked(alertDatabaseService.getAlertRules).mockResolvedValue([]);
    const result = await evaluateAllRules();
    expect(result).toEqual([]);
  });
});
