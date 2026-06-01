/**
 * BaselineCalculator 测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../src/db-connection', () => ({
  dbConnection: {
    getPool: () => mockPool,
    isConnected: () => true,
  },
}));

vi.mock('../src/metrics-database-service', () => ({
  metricsDatabaseService: {
    getHistoricalMetrics: vi.fn(() => []),
  },
}));

vi.mock('../src/instance-database-service', () => ({
  instanceDatabaseService: {
    getAllInstances: vi.fn(() => []),
  },
}));

vi.mock('../src/metric-registry', () => {
  const mockRegistry = {
    getMetricIds: () => ['cpu_usage', 'memory_usage', 'disk_usage'],
    isValidMetric: (id: string) => ['cpu_usage', 'memory_usage', 'disk_usage'].includes(id),
  };
  return {
    metricRegistry: mockRegistry,
    MetricRegistry: class {},
  };
});

let mockPool: any = null;

describe('BaselineCalculator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeBaselineForMetric', () => {
    it('应返回失败结果当数据库未连接时', async () => {
      mockPool = null;

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const result = await baselineCalculator.computeBaselineForMetric(1, 'cpu_usage');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('应返回失败结果当样本量不足时', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([[]]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const result = await baselineCalculator.computeBaselineForMetric(1, 'cpu_usage');
      expect(result.success).toBe(false);
    });

    it('应使用 SQL STDDEV_POP 计算基线', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([[
          {
            instance_id: 1,
            mean_val: 45.5,
            stddev_val: 10.2,
            sample_count: 15,
          },
        ]]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const result = await baselineCalculator.computeBaselineForMetric(1, 'cpu_usage');
      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.result!.mean).toBe(45.5);
      expect(result.result!.stddev).toBe(10.2);
      expect(result.result!.sampleCount).toBe(15);

      // 验证 SQL 包含 STDDEV_POP
      const sqlCall = mockPool.execute.mock.calls[0][0];
      expect(sqlCall).toContain('STDDEV_POP');
    });

    it('lower_bound 不应为负数（对正指标使用 Math.max(0, lowerBound)）', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([[
          {
            instance_id: 1,
            mean_val: 5,
            stddev_val: 10,
            sample_count: 20,
          },
        ]]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const result = await baselineCalculator.computeBaselineForMetric(1, 'cpu_usage');
      expect(result.success).toBe(true);
      expect(result.result!.lowerBound).toBeGreaterThanOrEqual(0);
    });

    it('应使用参数化查询防止 SQL 注入', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([[
          {
            instance_id: 1,
            mean_val: 50,
            stddev_val: 5,
            sample_count: 30,
          },
        ]]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      await baselineCalculator.computeBaselineForMetric(1, 'cpu_usage');

      const params = mockPool.execute.mock.calls[0][1];
      expect(params).toContain(1); // instance_id
    });
  });

  describe('getCachedBaseline', () => {
    it('应返回缓存的基线数据', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([[
          {
            mean_val: 45.5,
            stddev_val: 10.2,
            lower_bound: 25.1,
            upper_bound: 65.9,
          },
        ]]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const baseline = await baselineCalculator.getCachedBaseline(1, 'cpu_usage');
      expect(baseline).not.toBeNull();
      expect(baseline!.mean).toBe(45.5);
      expect(baseline!.stddev).toBe(10.2);
      expect(baseline!.lowerBound).toBe(25.1);
      expect(baseline!.upperBound).toBe(65.9);
    });

    it('无缓存数据时应返回 null', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([[]]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const baseline = await baselineCalculator.getCachedBaseline(1, 'nonexistent');
      expect(baseline).toBeNull();
    });
  });

  describe('computeAllBaselines', () => {
    it('应遍历所有实例和指标并返回统计', async () => {
      mockPool = {
        execute: vi.fn()
          .mockResolvedValueOnce([[{ instance_id: 1, mean_val: 50, stddev_val: 5, sample_count: 15 }]])
          .mockResolvedValue([[{ instance_id: 1, mean_val: 50, stddev_val: 5, sample_count: 15 }]]),
      };

      const { instanceDatabaseService } = await import('../src/instance-database-service');
      (instanceDatabaseService.getAllInstances as any).mockReturnValue([
        { id: 1, name: 'test-instance' },
      ]);

      const { baselineCalculator } = await import('../src/baseline-calculator');
      const result = await baselineCalculator.computeAllBaselines();
      expect(result.success).toBeGreaterThanOrEqual(0);
      expect(result.results).toBeDefined();
    });
  });

  describe('cleanupOldBaselines', () => {
    it('应调用 SQL 删除过期基线', async () => {
      mockPool = {
        execute: vi.fn().mockResolvedValue([{}]),
      };

      const { baselineCalculator } = await import('../src/baseline-calculator');
      await baselineCalculator.cleanupOldBaselines(30);

      expect(mockPool.execute).toHaveBeenCalled();
      const sqlCall = mockPool.execute.mock.calls[0][0];
      expect(sqlCall).toMatch(/DELETE.*metric_baselines/i);
    });
  });
});
