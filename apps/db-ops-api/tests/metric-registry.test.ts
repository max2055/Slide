/**
 * MetricRegistry 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MetricRegistry, MetricDefinition, metricRegistry } from '../src/metric-registry';

describe('MetricRegistry', () => {
  describe('预定义指标', () => {
    it('应包含 cpu_usage 指标', () => {
      const metric = metricRegistry.getById('cpu_usage');
      expect(metric).not.toBeNull();
      expect(metric!.unit).toBe('%');
    });

    it('应包含 memory_usage 指标', () => {
      const metric = metricRegistry.getById('memory_usage');
      expect(metric).not.toBeNull();
    });

    it('应包含 disk_usage 指标', () => {
      const metric = metricRegistry.getById('disk_usage');
      expect(metric).not.toBeNull();
      expect(metric!.aggregation).toBe('last');
    });

    it('应包含 connections 指标', () => {
      const metric = metricRegistry.getById('connections');
      expect(metric).not.toBeNull();
    });

    it('应包含 qps 指标', () => {
      const metric = metricRegistry.getById('qps');
      expect(metric).not.toBeNull();
    });

    it('应包含 tps 指标', () => {
      const metric = metricRegistry.getById('tps');
      expect(metric).not.toBeNull();
    });

    it('应包含 slow_queries 指标', () => {
      const metric = metricRegistry.getById('slow_queries');
      expect(metric).not.toBeNull();
    });

    it('应包含 buffer_pool_hit_rate 指标', () => {
      const metric = metricRegistry.getById('buffer_pool_hit_rate');
      expect(metric).not.toBeNull();
    });

    it('应包含 health_score 指标', () => {
      const metric = metricRegistry.getById('health_score');
      expect(metric).not.toBeNull();
      expect(metric!.unit).toBe('score');
    });
  });

  describe('查询方法', () => {
    it('getAll() 应返回所有预定义指标', () => {
      const all = metricRegistry.getAll();
      expect(all.length).toBeGreaterThanOrEqual(9);
    });

    it('getById() 应返回指定指标或 null', () => {
      const found = metricRegistry.getById('cpu_usage');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('cpu_usage');

      const notFound = metricRegistry.getById('nonexistent_metric');
      expect(notFound).toBeNull();
    });

    it('getByDbType() 应返回适用于指定数据库类型的指标', () => {
      const mysqlMetrics = metricRegistry.getByDbType('mysql');
      expect(mysqlMetrics.length).toBeGreaterThan(0);
      expect(mysqlMetrics.some(m => m.id === 'cpu_usage')).toBe(true);
    });

    it('isValidMetric() 应正确判断指标是否存在', () => {
      expect(metricRegistry.isValidMetric('cpu_usage')).toBe(true);
      expect(metricRegistry.isValidMetric('nonexistent')).toBe(false);
    });

    it('getMetricIds() 应返回所有指标 ID 列表', () => {
      const ids = metricRegistry.getMetricIds();
      expect(ids).toContain('cpu_usage');
      expect(ids).toContain('memory_usage');
      expect(ids).toContain('health_score');
    });
  });

  describe('MetricDefinition 接口', () => {
    it('cpu_usage 应有正确的 threshold_template', () => {
      const metric = metricRegistry.getById('cpu_usage');
      expect(metric!.threshold_template).toEqual({ warning: 80, error: 90, critical: 95 });
    });

    it('buffer_pool_hit_rate 的阈值方向应正确（warning > error 因为是命中率）', () => {
      const metric = metricRegistry.getById('buffer_pool_hit_rate');
      expect(metric!.threshold_template.warning).toBeGreaterThan(metric!.threshold_template.error);
    });

    it('health_score 的阈值方向应正确（阈值方向相反）', () => {
      const metric = metricRegistry.getById('health_score');
      expect(metric!.threshold_template.warning).toBeGreaterThan(metric!.threshold_template.critical);
    });

    it('disk_usage 应适用于 mysql 和 postgresql', () => {
      const metric = metricRegistry.getById('disk_usage');
      expect(metric!.db_types).toContain('mysql');
      expect(metric!.db_types).toContain('postgresql');
    });
  });
});
