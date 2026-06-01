/**
 * UnifiedCollector — 指标采集调度中心
 *
 * 从 metric_registry 读取指标定义，按 db_type 匹配 Provider，执行采集，记录到 metrics_history。
 * Provider 连续 3 次失败自动禁用 (D-13)。
 *
 * 模块初始化时自动注册所有 5 个内置 Provider。
 */
import { collectorRegistry } from './collectors/registry.js';
import { databaseService } from './database-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { metricRegistry } from './metric-registry.js';
import { collectionCapabilityTracker } from './collection-capabilities.js';
import type { MetricDefinition } from './metric-registry.js';
import type { DatabaseConnection } from './database-service.js';
import type { DatabaseInstance } from './instance-database-service.js';

// Fixed-column metrics — these have dedicated columns in metrics_history table
const FIXED_COLUMN_METRICS = new Set([
  'cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps', 'tps',
  'active_transactions', 'slow_queries', 'buffer_pool_hit_rate',
  'threads_running', 'threads_connected', 'bytes_received', 'bytes_sent',
  'queries_total', 'commits_total', 'rollbacks_total',
  'table_open_cache_hit_rate', 'handler_read_rnd_next', 'handler_read_rnd_next_rate',
  'key_blocks_usage', 'open_files', 'aborted_connects', 'aborted_connects_rate',
  'idx_scan_ratio', 'dead_tuples', 'cache_hit_ratio', 'connections_used', 'connections_max',
  'vacuum_count', 'autovacuum_count', 'replication_lag_seconds', 'data_size_gb',
]);

class UnifiedCollector {
  /**
   * 采集单个实例的所有到期指标
   *
   * 1) 按 instance.db_type 获取匹配的 Provider
   * 2) 循环各 Provider 和 metricDef
   * 3) 记录采集结果到 metrics_history
   * 4) 更新采集能力追踪
   */
  async collectInstance(instance: DatabaseInstance): Promise<void> {
    const dbType = instance.db_type;
    const providers = collectorRegistry.getProvidersByDbType(dbType);
    if (providers.length === 0) return;

    const conn = databaseService.getConnection(instance.id) as DatabaseConnection;
    if (!conn) return;

    // 读取该 db_type 的指标定义
    const definitions = metricRegistry.getByDbType(dbType)
      .filter((m: MetricDefinition) => m.is_collected);

    const results: Record<string, number> = {};

    for (const provider of providers) {
      if (!provider.enabled) continue;

      for (const def of definitions) {
        try {
          const val = await provider.collect(conn, def);
          if (val !== null) {
            results[def.id] = val;
          }
        } catch (e: any) {
          const failures = collectorRegistry.recordFailure(provider.name);
          console.error(`[Collector] ${provider.name} ${def.id} 采集异常:`, e.message);
          if (failures >= 3) {
            collectorRegistry.disable(provider.name);
            console.error(`[Collector] Provider ${provider.name} 连续失败 ${failures} 次，已自动禁用`);
          }
        }
      }
    }

    // 记录到 metrics_history
    if (Object.keys(results).length > 0) {
      const fixedCols: Record<string, number> = {};
      const dynamicData: Record<string, number> = {};

      for (const [key, val] of Object.entries(results)) {
        if (FIXED_COLUMN_METRICS.has(key)) {
          fixedCols[key] = val;
        } else {
          dynamicData[key] = val;
        }
      }

      const recordPayload: Record<string, unknown> = {
        instance_id: instance.id,
        ...fixedCols,
      };

      if (Object.keys(dynamicData).length > 0) {
        recordPayload.metrics_data = dynamicData;
      }

      await metricsDatabaseService.recordMetrics(recordPayload as any);

      // 更新采集能力追踪
      for (const def of definitions) {
        collectionCapabilityTracker.recordMetricAttempt(
          instance.id,
          def.name,
          results[def.id] !== undefined
        );
      }
    }
  }
}

export const unifiedCollector = new UnifiedCollector();

// ================== 自动注册所有 Provider ==================
import { MySQLProvider } from './collectors/mysql.provider.js';
import { PostgreSQLProvider } from './collectors/postgresql.provider.js';
import { OracleProvider } from './collectors/oracle.provider.js';
import { DamengProvider } from './collectors/dameng.provider.js';
import { CustomSQLProvider } from './collectors/custom-sql.provider.js';

collectorRegistry.register(new MySQLProvider());
collectorRegistry.register(new PostgreSQLProvider());
collectorRegistry.register(new OracleProvider());
collectorRegistry.register(new DamengProvider());
collectorRegistry.register(new CustomSQLProvider());

console.log('[UnifiedCollector] 5 个 Provider 已自动注册');
