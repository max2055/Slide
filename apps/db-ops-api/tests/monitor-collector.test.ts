/**
 * MonitorCollector 单元测试
 * 测试定时采集任务的核心功能
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { monitorCollector } from '../src/monitor-collector';

// Mock 依赖模块
vi.mock('../src/database-service', () => ({
  databaseService: {
    getRealtimeMetrics: vi.fn(),
    checkHealth: vi.fn(),
  },
}));

vi.mock('../src/metrics-database-service', () => ({
  metricsDatabaseService: {
    recordMetrics: vi.fn(),
  },
}));

vi.mock('../src/instance-database-service', () => ({
  instanceDatabaseService: {
    getAllInstances: vi.fn(),
    updateHealthStatus: vi.fn(),
    recordHealthCheck: vi.fn(),
  },
}));

describe('MonitorCollector', () => {
  beforeEach(() => {
    // 重置采集器状态
    monitorCollector.stop();
  });

  afterEach(() => {
    monitorCollector.stop();
  });

  it('应创建 3 个 cron 作业（metrics/slowQueries/capacity）', async () => {
    monitorCollector.start();
    const status = monitorCollector.getStatus();

    // 验证采集器正在运行
    expect(status.running).toBe(true);

    // 验证有 3 个作业
    expect(status.jobs).toBeDefined();
    expect(status.jobs.length).toBe(3);

    // 验证作业名称
    const jobNames = status.jobs.map((j) => j.name);
    expect(jobNames).toContain('metrics');
    expect(jobNames).toContain('slowQueries');
    expect(jobNames).toContain('capacity');
  });

  it('stop() 应停止所有作业', async () => {
    monitorCollector.start();
    monitorCollector.stop();

    const status = monitorCollector.getStatus();
    expect(status.running).toBe(false);

    // 所有作业应该停止
    status.jobs.forEach((job) => {
      expect(job.running).toBe(false);
    });
  });

  it('getStatus() 返回正确的运行状态和作业信息', async () => {
    monitorCollector.start();
    const status = monitorCollector.getStatus();

    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('jobs');
    expect(Array.isArray(status.jobs)).toBe(true);

    // 验证每个作业都有必要的属性
    status.jobs.forEach((job) => {
      expect(job).toHaveProperty('name');
      expect(job).toHaveProperty('running');
      expect(job).toHaveProperty('lastRun');
      expect(job).toHaveProperty('nextRun');
    });
  });

  it('start() 应是幂等的（重复调用不会创建重复作业）', async () => {
    monitorCollector.start();
    const status1 = monitorCollector.getStatus();
    const jobCount1 = status1.jobs.length;

    // 再次调用 start
    monitorCollector.start();
    const status2 = monitorCollector.getStatus();
    const jobCount2 = status2.jobs.length;

    // 作业数量应该相同
    expect(jobCount1).toBe(jobCount2);
  });
});
