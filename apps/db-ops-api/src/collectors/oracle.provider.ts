/**
 * OracleProvider — extracts Oracle metric queries from getOracleMetrics
 *
 * Each collect() call handles ONE metric by metricDef.id.
 * Delta counters use conn.oracleDeltaCounter.
 */
import { BaseMetricProvider } from './base-provider.js';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';

export class OracleProvider extends BaseMetricProvider {
  readonly name = 'Oracle Provider';
  readonly supportedDbTypes = ['oracle'];

  async collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null> {
    if (!instance || !instance.oracleConnection) return null;

    try {
      switch (metricDef.id) {
        case 'connections': {
          const result = await instance.oracleConnection.execute<[number]>(
            'SELECT COUNT(*) as count FROM V$SESSION'
          );
          return (result.rows?.[0]?.[0] as number) || 0;
        }

        case 'connections_max': {
          const result = await instance.oracleConnection.execute<[number]>(
            "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'processes'"
          );
          return (result.rows?.[0]?.[0] as number) || 300;
        }

        case 'cpu_usage': {
          const maxConnResult = await instance.oracleConnection.execute<[number]>(
            "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'processes'"
          );
          const maxConn = (maxConnResult.rows?.[0]?.[0] as number) || 300;
          const activeResult = await instance.oracleConnection.execute<[number]>(
            "SELECT COUNT(*) as count FROM V$SESSION WHERE STATUS = 'ACTIVE'"
          );
          const active = (activeResult.rows?.[0]?.[0] as number) || 0;
          return Math.min(100, Math.round((active / maxConn) * 100));
        }

        case 'memory_usage': {
          // PGA cache hit rate + tablespace usage estimate
          let pgaHitRate = 100;
          try {
            const pgaResult = await instance.oracleConnection.execute<[number]>(`
              SELECT ROUND((1 - (SELECT SUM(value) FROM V$SYSSTAT WHERE name = 'physical reads') /
                NULLIF((SELECT SUM(value) FROM V$SYSSTAT WHERE name = 'session pga memory') +
                (SELECT SUM(value) FROM V$SYSSTAT WHERE name = 'physical reads'), 0)) * 100, 2) as hit_rate FROM DUAL
            `);
            pgaHitRate = (pgaResult.rows?.[0]?.[0] as number) || 100;
          } catch { /* fallback */ }

          let tablespaceUsage = 50;
          try {
            const tsResult = await instance.oracleConnection.execute<[number]>(`
              SELECT MAX(usage_percent) FROM (
                SELECT ROUND((1 - NVL(fs.free_bytes, 0) / NULLIF(SUM(df.bytes), 0)) * 100, 2) as usage_percent
                FROM DBA_DATA_FILES df LEFT JOIN (
                  SELECT tablespace_name, SUM(bytes) as free_bytes FROM DBA_FREE_SPACE GROUP BY tablespace_name
                ) fs ON fs.tablespace_name = df.tablespace_name
                WHERE df.tablespace_name NOT IN ('SYSTEM', 'SYSAUX')
                GROUP BY df.tablespace_name, fs.free_bytes
              )
            `);
            tablespaceUsage = (tsResult.rows?.[0]?.[0] as number) ?? 50;
          } catch { /* fallback */ }
          return Math.min(100, Math.round((100 - pgaHitRate) * 0.5 + tablespaceUsage * 0.5));
        }

        case 'disk_usage':
        case 'tablespace_usage': {
          try {
            const tsResult = await instance.oracleConnection.execute<[number]>(`
              SELECT MAX(usage_percent) FROM (
                SELECT ROUND((1 - NVL(fs.free_bytes, 0) / NULLIF(SUM(df.bytes), 0)) * 100, 2) as usage_percent
                FROM DBA_DATA_FILES df LEFT JOIN (
                  SELECT tablespace_name, SUM(bytes) as free_bytes FROM DBA_FREE_SPACE GROUP BY tablespace_name
                ) fs ON fs.tablespace_name = df.tablespace_name
                WHERE df.tablespace_name NOT IN ('SYSTEM', 'SYSAUX')
                GROUP BY df.tablespace_name, fs.free_bytes
              )
            `);
            return (tsResult.rows?.[0]?.[0] as number) ?? null;
          } catch {
            return null;
          }
        }

        case 'qps': {
          const statResult = await instance.oracleConnection.execute<[number, number, number, number]>(`
            SELECT
              SUM(CASE WHEN NAME = 'execute count' THEN VALUE ELSE 0 END) as executes,
              SUM(CASE WHEN NAME = 'user commits' THEN VALUE ELSE 0 END) as commits
            FROM V$SYSSTAT
            WHERE NAME IN ('execute count', 'user commits')
          `);
          const executes = (statResult.rows?.[0]?.[0] as number) || 0;
          const now = Date.now();
          if (!instance.oracleDeltaCounter) {
            instance.oracleDeltaCounter = { executes, commits: 0, timestamp: now };
            return 0;
          }
          const elapsed = (now - instance.oracleDeltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          const delta = executes - instance.oracleDeltaCounter.executes;
          const rate = Math.max(0, Math.round(delta / elapsed));
          instance.oracleDeltaCounter.executes = executes;
          instance.oracleDeltaCounter.timestamp = now;
          return rate;
        }

        case 'tps': {
          const statResult = await instance.oracleConnection.execute<[number, number]>(`
            SELECT
              SUM(CASE WHEN NAME = 'user commits' THEN VALUE ELSE 0 END) as commits
            FROM V$SYSSTAT
            WHERE NAME IN ('user commits')
          `);
          const commits = (statResult.rows?.[0]?.[0] as number) || 0;
          const now = Date.now();
          if (!instance.oracleDeltaCounter) {
            instance.oracleDeltaCounter = { executes: 0, commits, timestamp: now };
            return 0;
          }
          const elapsed = (now - instance.oracleDeltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          const delta = commits - instance.oracleDeltaCounter.commits;
          const rate = Math.max(0, Math.round(delta / elapsed));
          instance.oracleDeltaCounter.commits = commits;
          instance.oracleDeltaCounter.timestamp = now;
          return rate;
        }

        case 'slow_queries':
          return 0; // Oracle uses V$SQLAREA based analysis, not a simple counter

        case 'sga_hit_rate': {
          // SGA hit rate = buffer cache hit rate via V$SYSSTAT
          try {
            const result = await instance.oracleConnection.execute<[number]>(`
              SELECT ROUND((1 - (SUM(DECODE(NAME, 'physical reads', VALUE, 0)) /
                NULLIF(SUM(DECODE(NAME, 'db block gets', VALUE, 0)) + SUM(DECODE(NAME, 'consistent gets', VALUE, 0)), 0))) * 100, 2)
              FROM V$SYSSTAT
            `);
            return (result.rows?.[0]?.[0] as number) || 100;
          } catch {
            return 100;
          }
        }

        case 'deadlock_count': {
          try {
            const result = await instance.oracleConnection.execute<[number]>(
              "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
            );
            return (result.rows?.[0]?.[0] as number) || 0;
          } catch {
            return 0;
          }
        }

        case 'active_sessions': {
          const result = await instance.oracleConnection.execute<[number]>(
            "SELECT COUNT(*) as count FROM V$SESSION WHERE STATUS = 'ACTIVE'"
          );
          return (result.rows?.[0]?.[0] as number) || 0;
        }

        case 'sga_size_mb': {
          try {
            const result = await instance.oracleConnection.execute<[number]>(
              'SELECT ROUND(SUM(bytes)/1024/1024, 2) FROM V$SGA'
            );
            return (result.rows?.[0]?.[0] as number) || 0;
          } catch {
            return 0;
          }
        }

        case 'pga_size_mb': {
          try {
            const result = await instance.oracleConnection.execute<[number]>(
              "SELECT ROUND(value/1024/1024, 2) FROM V$PGASTAT WHERE NAME = 'total PGA allocated'"
            );
            return (result.rows?.[0]?.[0] as number) || 0;
          } catch {
            return 0;
          }
        }

        default:
          return null;
      }
    } catch (error) {
      console.error(`[OracleProvider] ${metricDef.id} 采集失败:`, error);
      throw error;
    }
  }
}
