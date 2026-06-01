/**
 * MySQLProvider — extracts MySQL metric queries from database-service.ts getMySQLMetrics
 *
 * Each collect() call handles ONE metric by metricDef.id, returns a single scalar.
 * Delta counters (qps, tps, handler_read_rnd_next_rate, aborted_connects_rate)
 * are stored on conn.deltaCounter.
 */
import { BaseMetricProvider } from './base-provider.js';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';
import type { RowDataPacket } from 'mysql2/promise';

export class MySQLProvider extends BaseMetricProvider {
  readonly name = 'MySQL Provider';
  readonly supportedDbTypes = ['mysql'];

  async collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null> {
    if (!instance || !instance.pool) return null;

    try {
      switch (metricDef.id) {
        case 'connections': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            'SELECT COUNT(*) as count FROM information_schema.PROCESSLIST'
          );
          return rows[0]?.count ?? null;
        }

        case 'cpu_usage': {
          const [maxConnResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW VARIABLES LIKE 'max_connections'"
          );
          const maxConn = Number(maxConnResult[0]?.Value) || 151;
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_running', 'Threads_connected')"
          );
          const threadsRunning = Number(statusResult.find((r: any) => r.Variable_name === 'Threads_running')?.Value) || 0;
          return Math.min(100, Math.round((threadsRunning / Math.max(1, maxConn)) * 60 + 20));
        }

        case 'memory_usage': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_pages_total', 'Innodb_buffer_pool_pages_free')"
          );
          const total = Number(rows.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_pages_total')?.Value) || 1;
          const free = Number(rows.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_pages_free')?.Value) || 0;
          return Math.round(((total - free) / total) * 100);
        }

        case 'disk_usage': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            "SELECT COALESCE(SUM(data_length + index_length), 0) as total_bytes FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')"
          );
          const dataSizeGb = Math.round((Number(rows[0]?.total_bytes) || 0) / (1024 * 1024 * 1024) * 100) / 100;
          return Math.min(95, Math.round(dataSizeGb / 10 * 100));
        }

        case 'data_size_gb': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            "SELECT COALESCE(SUM(data_length + index_length), 0) as total_bytes FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')"
          );
          return Math.round((Number(rows[0]?.total_bytes) || 0) / (1024 * 1024 * 1024) * 100) / 100;
        }

        case 'qps': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Queries', 'Uptime')"
          );
          const queries = Number(statusResult.find((r: any) => r.Variable_name === 'Queries')?.Value) || 0;
          const now = Date.now();
          if (!instance.deltaCounter) {
            instance.deltaCounter = {
              queries, commits: 0, rollbacks: 0,
              bytesReceived: 0, bytesSent: 0, slowQueries: 0,
              timestamp: now, abortedConnects: 0, handlerReadRndNext: 0,
            };
            return 0;
          }
          const elapsed = (now - instance.deltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          const rate = Math.round((queries - instance.deltaCounter.queries) / elapsed);
          instance.deltaCounter.queries = queries;
          instance.deltaCounter.timestamp = now;
          return rate;
        }

        case 'tps': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Com_commit', 'Com_rollback')"
          );
          const commits = Number(statusResult.find((r: any) => r.Variable_name === 'Com_commit')?.Value) || 0;
          const rollbacks = Number(statusResult.find((r: any) => r.Variable_name === 'Com_rollback')?.Value) || 0;
          const now = Date.now();
          if (!instance.deltaCounter) {
            instance.deltaCounter = {
              queries: 0, commits, rollbacks,
              bytesReceived: 0, bytesSent: 0, slowQueries: 0,
              timestamp: now, abortedConnects: 0, handlerReadRndNext: 0,
            };
            return 0;
          }
          const elapsed = (now - instance.deltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          const rate = Math.round(((commits + rollbacks) - (instance.deltaCounter.commits + instance.deltaCounter.rollbacks)) / elapsed);
          instance.deltaCounter.commits = commits;
          instance.deltaCounter.rollbacks = rollbacks;
          instance.deltaCounter.timestamp = now;
          return rate;
        }

        case 'slow_queries': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Slow_queries'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'buffer_pool_hit_rate': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')"
          );
          const requests = Number(rows.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_read_requests')?.Value) || 0;
          const reads = Number(rows.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_reads')?.Value) || 0;
          if (requests <= 0) return 100;
          return Math.round((requests - reads) / requests * 10000) / 100;
        }

        case 'threads_running': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Threads_running'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'threads_connected': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Threads_connected'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'bytes_received': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Bytes_received'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'bytes_sent': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Bytes_sent'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'queries_total': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Queries'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'commits_total': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Com_commit'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'rollbacks_total': {
          const [statusResult] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Com_rollback'"
          );
          return Number(statusResult[0]?.Value) || 0;
        }

        case 'table_open_cache_hit_rate': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Table_open_cache_hits', 'Table_open_cache_misses', 'Table_open_cache_overflows')"
          );
          const hits = Number(rows.find((r: any) => r.Variable_name === 'Table_open_cache_hits')?.Value) || 0;
          const misses = Number(rows.find((r: any) => r.Variable_name === 'Table_open_cache_misses')?.Value) || 0;
          if (hits + misses <= 0) return 100;
          return Math.round(hits / (hits + misses) * 10000) / 100;
        }

        case 'handler_read_rnd_next': {
          const [result] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Handler_read_rnd_next'"
          );
          return Number(result[0]?.Value) || 0;
        }

        case 'handler_read_rnd_next_rate': {
          const [result] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Handler_read_rnd_next'"
          );
          const current = Number(result[0]?.Value) || 0;
          const now = Date.now();
          if (!instance.deltaCounter) {
            instance.deltaCounter = {
              queries: 0, commits: 0, rollbacks: 0,
              bytesReceived: 0, bytesSent: 0, slowQueries: 0,
              timestamp: now, abortedConnects: 0, handlerReadRndNext: current,
            };
            return 0;
          }
          const elapsed = (now - instance.deltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          if (current < instance.deltaCounter.handlerReadRndNext) {
            // Counter reset (server restart)
            instance.deltaCounter.handlerReadRndNext = current;
            return 0;
          }
          const rate = Math.round((current - instance.deltaCounter.handlerReadRndNext) / elapsed * 100) / 100;
          instance.deltaCounter.handlerReadRndNext = current;
          return rate;
        }

        case 'key_blocks_usage': {
          const [rows] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Key_blocks_used', 'Key_blocks_unused')"
          );
          const used = Number(rows.find((r: any) => r.Variable_name === 'Key_blocks_used')?.Value) || 0;
          const unused = Number(rows.find((r: any) => r.Variable_name === 'Key_blocks_unused')?.Value) || 0;
          if (used + unused <= 0) return 0;
          return Math.round(used / (used + unused) * 10000) / 100;
        }

        case 'open_files': {
          const [result] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Open_files'"
          );
          return Number(result[0]?.Value) || 0;
        }

        case 'aborted_connects': {
          const [result] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Aborted_connects'"
          );
          return Number(result[0]?.Value) || 0;
        }

        case 'aborted_connects_rate': {
          const [result] = await instance.pool.query<RowDataPacket[]>(
            "SHOW GLOBAL STATUS WHERE Variable_name = 'Aborted_connects'"
          );
          const current = Number(result[0]?.Value) || 0;
          const now = Date.now();
          if (!instance.deltaCounter) {
            instance.deltaCounter = {
              queries: 0, commits: 0, rollbacks: 0,
              bytesReceived: 0, bytesSent: 0, slowQueries: 0,
              timestamp: now, abortedConnects: current, handlerReadRndNext: 0,
            };
            return 0;
          }
          const elapsed = (now - instance.deltaCounter.timestamp) / 1000;
          if (elapsed <= 0) return 0;
          if (current < instance.deltaCounter.abortedConnects) {
            instance.deltaCounter.abortedConnects = current;
            return 0;
          }
          const rate = Math.round((current - instance.deltaCounter.abortedConnects) / elapsed * 100) / 100;
          instance.deltaCounter.abortedConnects = current;
          return rate;
        }

        default:
          return null;
      }
    } catch (error) {
      console.error(`[MySQLProvider] ${metricDef.id} 采集失败:`, error);
      throw error;
    }
  }
}
