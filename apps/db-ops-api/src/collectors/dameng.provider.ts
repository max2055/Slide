/**
 * DamengProvider — extracts Dameng metric queries from getDamengMetrics
 *
 * Each collect() call handles ONE metric by metricDef.id.
 * Dameng has no delta counter — QPS/TPS use current process sampling.
 */
import { BaseMetricProvider } from './base-provider.js';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';

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
          return (result.rows?.[0]?.[0] as number) || 0;
        }

        case 'connections_max': {
          const result = await instance.dmConnection.execute<[[number]]>(
            "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'"
          );
          return (result.rows?.[0]?.[0] as number) || 500;
        }

        case 'cpu_usage': {
          const maxConnResult = await instance.dmConnection.execute<[[number]]>(
            "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'"
          );
          const maxConn = (maxConnResult.rows?.[0]?.[0] as number) || 500;
          const activeResult = await instance.dmConnection.execute<[[number]]>(
            "SELECT COUNT(*) as count FROM V$SESSIONS WHERE STATE = 'ACTIVE'"
          );
          const active = (activeResult.rows?.[0]?.[0] as number) || 0;
          return Math.min(100, Math.round((active / maxConn) * 100));
        }

        case 'memory_usage': {
          // Buffer hit rate based estimate
          const bufferResult = await instance.dmConnection.execute<[[number]]>(`
            SELECT NVL(RAT_HIT, 0) * 100 as hit_rate FROM V$BUFFERPOOL WHERE ID = 0
          `);
          const dmBufferHitRate = (bufferResult.rows?.[0]?.[0] as number) || 100;
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
          const executes = (statResult.rows?.[0]?.[0] as number) || 0;
          return Math.floor(executes / 100);
        }

        case 'tps': {
          const statResult = await instance.dmConnection.execute<[[number, number]]>(`
            SELECT
              SUM(CASE WHEN NAME = 'transaction commit count' THEN STAT_VAL ELSE 0 END) as commits
            FROM V$SYSSTAT
            WHERE NAME IN ('transaction commit count')
          `);
          const commits = (statResult.rows?.[0]?.[0] as number) || 0;
          return Math.floor(commits / 10);
        }

        case 'slow_queries':
          return 0;

        case 'dm_buffer_hit_rate': {
          const result = await instance.dmConnection.execute<[[number]]>(`
            SELECT NVL(RAT_HIT, 0) * 100 as hit_rate FROM V$BUFFERPOOL WHERE ID = 0
          `);
          const rate = (result.rows?.[0]?.[0] as number) || 100;
          return Math.round(rate * 100) / 100;
        }

        case 'dm_lock_wait': {
          try {
            const result = await instance.dmConnection.execute<[[number]]>(
              "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
            );
            return (result.rows?.[0]?.[0] as number) || 0;
          } catch {
            try {
              const result = await instance.dmConnection.execute<[[number]]>(
                "SELECT COUNT(*) as count FROM V$LOCK"
              );
              return (result.rows?.[0]?.[0] as number) || 0;
            } catch {
              return 0;
            }
          }
        }

        case 'dm_deadlock_count': {
          const result = await instance.dmConnection.execute<[[number]]>(
            "SELECT COUNT(*) as count FROM V$DEADLOCK_HISTORY"
          );
          return (result.rows?.[0]?.[0] as number) || 0;
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
