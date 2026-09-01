/**
 * DamengProvider — extracts Dameng metric queries from getDamengMetrics
 *
 * Each collect() call handles ONE metric by metricDef.id.
 * QPS/TPS use metric-specific counter baselines on the connection.
 */
import { BaseMetricProvider, calculateCounterRate } from './base-provider.js';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';

function scalar(rows: unknown): number | undefined {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) return undefined;
  const numeric = Number(rows[0][0]);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export class DamengProvider extends BaseMetricProvider {
  readonly name = 'Dameng Provider';
  readonly supportedDbTypes = ['dameng'];

  async collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null> {
    if (!instance || !instance.dmConnection) return null;

    try {
      switch (metricDef.id) {
        case 'connections': {
          const result = await instance.dmConnection.execute<[[number]]>(
            'SELECT COUNT(*) as count FROM V$SESSIONS'
          );
          return scalar(result.rows) ?? 0;
        }

        case 'connections_max': {
          const result = await instance.dmConnection.execute<[[number]]>(
            "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'"
          );
          return scalar(result.rows) ?? 500;
        }

        case 'cpu_usage': {
          const maxConnResult = await instance.dmConnection.execute<[[number]]>(
            "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'"
          );
          const maxConn = scalar(maxConnResult.rows) ?? 500;
          const activeResult = await instance.dmConnection.execute<[[number]]>(
            "SELECT COUNT(*) as count FROM V$SESSIONS WHERE STATE = 'ACTIVE'"
          );
          const active = scalar(activeResult.rows) ?? 0;
          return Math.min(100, Math.round((active / maxConn) * 100));
        }

        case 'memory_usage': {
          // Buffer hit rate based estimate
          const bufferResult = await instance.dmConnection.execute<[[number]]>(`
            SELECT NVL(RAT_HIT, 0) * 100 as hit_rate FROM V$BUFFERPOOL WHERE ID = 0
          `);
          const dmBufferHitRate = scalar(bufferResult.rows) ?? 100;
          return Math.min(100, Math.round((100 - dmBufferHitRate) * 0.5 + 30));
        }

        case 'disk_usage': {
          return 45; // Dameng default estimate same as original
        }

        case 'qps': {
          const statResult = await instance.dmConnection.execute<[[number, number]]>(`
            SELECT
              SUM(CASE WHEN NAME = 'sql executed count' THEN STAT_VAL ELSE 0 END) as executes
            FROM V$SYSSTAT
            WHERE NAME IN ('sql executed count')
          `);
          const executes = scalar(statResult.rows) ?? 0;
          return calculateCounterRate(instance, 'qps', executes);
        }

        case 'tps': {
          const statResult = await instance.dmConnection.execute<[[number, number]]>(`
            SELECT
              SUM(CASE WHEN NAME = 'transaction commit count' THEN STAT_VAL ELSE 0 END) as commits
            FROM V$SYSSTAT
            WHERE NAME IN ('transaction commit count')
          `);
          const commits = scalar(statResult.rows) ?? 0;
          return calculateCounterRate(instance, 'tps', commits);
        }

        case 'slow_queries':
          return 0;

        case 'dm_buffer_hit_rate': {
          const result = await instance.dmConnection.execute<[[number]]>(`
            SELECT NVL(RAT_HIT, 0) * 100 as hit_rate FROM V$BUFFERPOOL WHERE ID = 0
          `);
          const rate = scalar(result.rows) ?? 100;
          return Math.round(rate * 100) / 100;
        }

        case 'dm_lock_wait': {
          try {
            const result = await instance.dmConnection.execute<[[number]]>(
              "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
            );
            return scalar(result.rows) ?? 0;
          } catch {
            try {
              const result = await instance.dmConnection.execute<[[number]]>(
                "SELECT COUNT(*) as count FROM V$LOCK"
              );
              return scalar(result.rows) ?? 0;
            } catch {
              return 0;
            }
          }
        }

        case 'dm_deadlock_count': {
          const result = await instance.dmConnection.execute<[[number]]>(
            "SELECT COUNT(*) as count FROM V$DEADLOCK_HISTORY"
          );
          return scalar(result.rows) ?? 0;
        }

        default:
          return null;
      }
    } catch (error) {
      console.error(`[DamengProvider] ${metricDef.id} 采集失败:`, error);
      throw error;
    }
  }
}
