/**
 * MonitorCollector 单元测试
 * Phase 134: migrated from cron jobs to setInterval timers + worker lease
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
    monitorCollector.stop();
  });

  afterEach(() => {
    monitorCollector.stop();
  });

  it('start() 启动采集并设置 running 状态', async () => {
    monitorCollector.start();
    const status = monitorCollector.getStatus();

    expect(status.running).toBe(true);
    expect(status.heartbeatMs).toBeGreaterThan(0);
    expect(Array.isArray(status.schedule)).toBe(true);
  });

  it('stop() 停止所有定时器并清除 running 状态', async () => {
    monitorCollector.start();
    monitorCollector.stop();

    const status = monitorCollector.getStatus();
    expect(status.running).toBe(false);
  });

  it('getStatus() 返回心跳间隔和采集计划', async () => {
    monitorCollector.start();
    const status = monitorCollector.getStatus();

    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('heartbeatMs');
    expect(status).toHaveProperty('schedule');
    expect(typeof status.heartbeatMs).toBe('number');
    expect(Array.isArray(status.schedule)).toBe(true);
  });

  it('start() 应是幂等的（重复调用不会创建重复定时器）', async () => {
    monitorCollector.start();
    const status1 = monitorCollector.getStatus();

    monitorCollector.start();
    const status2 = monitorCollector.getStatus();

    expect(status2.running).toBe(true);
    expect(status2.heartbeatMs).toBe(status1.heartbeatMs);
  });
});
