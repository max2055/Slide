/**
 * PostgreSQLProvider — extracts PostgreSQL metric queries from getPostgreSQLMetrics
 *
 * Each collect() call handles ONE metric by metricDef.id.
 * Delta counters use conn.pgDeltaCounter.
 */
import { BaseMetricProvider } from './base-provider.js';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';

export class PostgreSQLProvider extends BaseMetricProvider {
  readonly name = 'PostgreSQL Provider';
  readonly supportedDbTypes = ['postgresql'];

  async collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null> {
    if (!instance || !instance.pgClient) return null;

    try {
      switch (metricDef.id) {
        case 'connections': {
          const result = await instance.pgClient.query<{ count: string }>(
            'SELECT COUNT(*) FROM pg_stat_activity'
          );
          return parseInt(result.rows[0]?.count || '0');
        }

        case 'cpu_usage': {
          const maxConnResult = await instance.pgClient.query<{ setting: string }>(
            'SHOW max_connections'
          );
          const maxConn = parseInt(maxConnResult.rows[0]?.setting || '100');
          const cpuResult = await instance.pgClient.query<{ active: string }>(
            `SELECT COUNT(*) FILTER (WHERE state = 'active') as active FROM pg_stat_activity WHERE state IS NOT NULL`
          );
          const active = parseInt(cpuResult.rows[0]?.active || '0');
          return Math.min(100, Math.round((active / maxConn) * 100));
        }

        case 'memory_usage': {
          const sessResult = await instance.pgClient.query<{ total: string; active: string }>(
            `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE state = 'active') as active FROM pg_stat_activity WHERE state IS NOT NULL`
          );
          const total = parseInt(sessResult.rows[0]?.total || '1');
          const active = parseInt(sessResult.rows[0]?.active || '0');
          return Math.min(100, Math.round((active / Math.max(1, total)) * 50 + 20));
        }

        case 'disk_usage':
        case 'data_size_gb': {
          const result = await instance.pgClient.query<{ size_bytes: string }>(
            'SELECT pg_database_size(current_database()) as size_bytes'
          );
          const sizeGb = Math.round(Number(result.rows[0]?.size_bytes || 0) / (1024 * 1024 * 1024) * 100) / 100;
          return metricDef.id === 'data_size_gb' ? sizeGb : Math.min(95, Math.round(sizeGb / 10 * 100));
        }

        case 'qps': {
          const dbStatsResult = await instance.pgClient.query<{ xact_commit: string }>(
            `SELECT COALESCE(SUM(xact_commit), 0) as xact_commit FROM pg_stat_database WHERE datname = current_database()`
          );
          const xactCommit = parseInt(dbStatsResult.rows[0]?.xact_commit || '0');
          const now = Date.now();
          if (!instance.pgDeltaCounter) {
            instance.pgDeltaCounter = { xactCommit, xactRollback: 0, blksRead: 0, blksHit: 0, timestamp: now };
            return 0;
          }
          const elapsed = (now - instance.pgDeltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          const rate = Math.round((xactCommit - instance.pgDeltaCounter.xactCommit) / elapsed);
          instance.pgDeltaCounter.xactCommit = xactCommit;
          instance.pgDeltaCounter.timestamp = now;
          return rate;
        }

        case 'tps': {
          const dbStatsResult = await instance.pgClient.query<{ xact_commit: string; xact_rollback: string }>(
            `SELECT COALESCE(SUM(xact_commit), 0) as xact_commit, COALESCE(SUM(xact_rollback), 0) as xact_rollback FROM pg_stat_database WHERE datname = current_database()`
          );
          const xactCommit = parseInt(dbStatsResult.rows[0]?.xact_commit || '0');
          const xactRollback = parseInt(dbStatsResult.rows[0]?.xact_rollback || '0');
          const now = Date.now();
          if (!instance.pgDeltaCounter) {
            instance.pgDeltaCounter = { xactCommit, xactRollback, blksRead: 0, blksHit: 0, timestamp: now };
            return 0;
          }
          const elapsed = (now - instance.pgDeltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          const rate = Math.round(((xactCommit + xactRollback) - (instance.pgDeltaCounter.xactCommit + instance.pgDeltaCounter.xactRollback)) / elapsed);
          instance.pgDeltaCounter.xactCommit = xactCommit;
          instance.pgDeltaCounter.xactRollback = xactRollback;
          instance.pgDeltaCounter.timestamp = now;
          return rate;
        }

        case 'slow_queries':
          return 0; // PG has no simple slow query counter — use pg_stat_statements

        case 'cache_hit_ratio':
        case 'cache_hit_rate': {
          const colCheck = await instance.pgClient.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'pg_catalog' AND table_name = 'pg_stat_database'`
          );
          const colSets = [['blks_read', 'blks_hit'], ['blk_read', 'blk_hit']];
          const availCols = colCheck.rows.map((r: any) => r.column_name);
          const match = colSets.find(([r, h]) => availCols.includes(r) && availCols.includes(h));
          if (!match) return 100;
          const [readCol, hitCol] = match;
          const statsResult = await instance.pgClient.query(
            `SELECT COALESCE(SUM(${readCol}), 0) as blk_read, COALESCE(SUM(${hitCol}), 0) as blk_hit FROM pg_stat_database WHERE datname = current_database()`
          );
          const read = parseInt(statsResult.rows[0]?.blk_read || '0');
          const hit = parseInt(statsResult.rows[0]?.blk_hit || '0');
          const total = read + hit;
          return total > 0 ? Math.round(hit / total * 10000) / 100 : 100;
        }

        case 'idx_scan_ratio': {
          const result = await instance.pgClient.query<{ idx: string; seq: string }>(
            "SELECT COALESCE(SUM(idx_scan), 0) as idx, COALESCE(SUM(seq_scan), 0) as seq FROM pg_stat_user_tables"
          );
          const idx = parseInt(result.rows[0]?.idx || '0');
          const seq = parseInt(result.rows[0]?.seq || '0');
          return (idx + seq) > 0 ? Math.round(idx / (idx + seq) * 10000) / 100 : 100;
        }

        case 'dead_tuples': {
          const result = await instance.pgClient.query<{ dead: string }>(
            "SELECT COALESCE(SUM(n_dead_tup), 0) as dead FROM pg_stat_user_tables"
          );
          return parseInt(result.rows[0]?.dead || '0');
        }

        case 'connections_used': {
          const result = await instance.pgClient.query<{ count: string }>(
            'SELECT COUNT(*) FROM pg_stat_activity'
          );
          return parseInt(result.rows[0]?.count || '0');
        }

        case 'connections_max': {
          const result = await instance.pgClient.query<{ setting: string }>(
            'SHOW max_connections'
          );
          return parseInt(result.rows[0]?.setting || '100');
        }

        case 'vacuum_count': {
          try {
            const result = await instance.pgClient.query<{ vacuum_count: string }>(
              "SELECT COUNT(*) FILTER (WHERE last_vacuum IS NOT NULL) as vacuum_count FROM pg_stat_user_tables"
            );
            return parseInt(result.rows[0]?.vacuum_count || '0');
          } catch {
            return 0;
          }
        }

        case 'autovacuum_count': {
          try {
            const result = await instance.pgClient.query<{ autovacuum_count: string }>(
              "SELECT COUNT(*) FILTER (WHERE last_autovacuum IS NOT NULL) as autovacuum_count FROM pg_stat_user_tables"
            );
            return parseInt(result.rows[0]?.autovacuum_count || '0');
          } catch {
            return 0;
          }
        }

        case 'replication_lag_seconds': {
          try {
            const result = await instance.pgClient.query<{ lag_seconds: string }>(
              "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0) as lag_seconds"
            );
            return Math.round(Number(result.rows[0]?.lag_seconds || 0) * 100) / 100;
          } catch {
            return 0;
          }
        }

        default:
          return null;
      }
    } catch (error) {
      console.error(`[PostgreSQLProvider] ${metricDef.id} 采集失败:`, error);
      throw error;
    }
  }
}
