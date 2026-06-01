/**
 * 监控指标数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface MetricsRecord {
  id: number;
  instance_id: number;
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  connections: number;
  qps: number;
  tps: number;
  active_transactions: number;
  slow_queries: number;
  buffer_pool_hit_rate: number;
  threads_running: number;
  threads_connected: number;
  bytes_received: number;
  bytes_sent: number;
  queries_total: number;
  commits_total: number;
  rollbacks_total: number;
  metrics_data?: Record<string, number>;
  recorded_at: Date;
}

export interface FaultDiagnosis {
  id: number;
  instance_id: number;
  fault_type: string;
  fault_name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  diagnosis: string;
  evidence: any;
  solution: string;
  status: 'pending' | 'investigating' | 'resolved' | 'dismissed';
  auto_heal_possible: boolean;
  actions_taken: any;
  healed: boolean;
  healed_at: Date | null;
  resolved_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface SlowQueryRecord {
  id: number;
  instance_id: number;
  sql_text: string;
  sql_hash: string;
  avg_time_ms: number;
  max_time_ms: number;
  min_time_ms: number;
  execution_count: number;
  total_time_ms: number;
  rows_examined: number;
  rows_sent: number;
  first_seen: Date;
  last_seen: Date;
  digest_text: string | null;
  schema_name: string | null;
  user_name: string | null;
  host_name: string | null;
  created_at: Date;
  updated_at: Date;
}

class MetricsDatabaseService {
  /**
   * 获取数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 检查数据库是否已连接
   */
  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  /**
   * 记录监控指标
   */
  async recordMetrics(data: {
    instance_id: number;
    cpu_usage?: number;
    memory_usage?: number;
    disk_usage?: number;
    connections?: number;
    qps?: number;
    tps?: number;
    active_transactions?: number;
    slow_queries?: number;
    buffer_pool_hit_rate?: number;
    threads_running?: number;
    threads_connected?: number;
    bytes_received?: number;
    bytes_sent?: number;
    queries_total?: number;
    commits_total?: number;
    rollbacks_total?: number;
    table_open_cache_hit_rate?: number;
    handler_read_rnd_next?: number;
    handler_read_rnd_next_rate?: number;
    key_blocks_usage?: number;
    open_files?: number;
    aborted_connects?: number;
    aborted_connects_rate?: number;
    idx_scan_ratio?: number;
    dead_tuples?: number;
    cache_hit_ratio?: number;
    connections_used?: number;
    connections_max?: number;
    vacuum_count?: number;
    autovacuum_count?: number;
    replication_lag_seconds?: number;
    data_size_gb?: number;
    is_estimated?: boolean;
    metrics_data?: Record<string, number>;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `INSERT INTO metrics_history
         (instance_id, cpu_usage, memory_usage, disk_usage, connections,
          qps, tps, active_transactions, slow_queries,
          buffer_pool_hit_rate, threads_running, threads_connected,
          bytes_received, bytes_sent, queries_total, commits_total, rollbacks_total,
          table_open_cache_hit_rate, handler_read_rnd_next, handler_read_rnd_next_rate,
          key_blocks_usage, open_files, aborted_connects, aborted_connects_rate,
          idx_scan_ratio, dead_tuples, cache_hit_ratio, connections_used, connections_max,
          vacuum_count, autovacuum_count, replication_lag_seconds, data_size_gb, is_estimated, metrics_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.instance_id,
          data.cpu_usage ?? 0,
          data.memory_usage ?? 0,
          data.disk_usage ?? 0,
          data.connections ?? 0,
          data.qps ?? 0,
          data.tps ?? 0,
          data.active_transactions ?? 0,
          data.slow_queries ?? 0,
          data.buffer_pool_hit_rate ?? 0,
          data.threads_running ?? 0,
          data.threads_connected ?? 0,
          data.bytes_received ?? 0,
          data.bytes_sent ?? 0,
          data.queries_total ?? 0,
          data.commits_total ?? 0,
          data.rollbacks_total ?? 0,
          data.table_open_cache_hit_rate ?? null,
          data.handler_read_rnd_next ?? null,
          data.handler_read_rnd_next_rate ?? null,
          data.key_blocks_usage ?? null,
          data.open_files ?? null,
          data.aborted_connects ?? null,
          data.aborted_connects_rate ?? null,
          data.idx_scan_ratio ?? null,
          data.dead_tuples ?? null,
          data.cache_hit_ratio ?? null,
          data.connections_used ?? null,
          data.connections_max ?? null,
          data.vacuum_count ?? null,
          data.autovacuum_count ?? null,
          data.replication_lag_seconds ?? null,
          data.data_size_gb ?? null,
          data.is_estimated ?? false,
          data.metrics_data ? JSON.stringify(data.metrics_data) : null,
        ]
      );

      return { success: true };
    } catch (error: any) {
      console.error('记录监控指标失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取实时指标（最新一条记录）
   */
  async getRealtimeMetrics(instanceId: number): Promise<MetricsRecord | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, instance_id, cpu_usage, memory_usage, disk_usage,
                connections, qps, tps, active_transactions, slow_queries,
                buffer_pool_hit_rate, threads_running, threads_connected,
                bytes_received, bytes_sent, queries_total, commits_total,
                rollbacks_total, metrics_data, recorded_at
         FROM metrics_history
         WHERE instance_id = ?
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [instanceId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as MetricsRecord;
      }
      return null;
    } catch (error) {
      console.error('获取实时指标失败:', error);
      return null;
    }
  }

  /**
   * 获取历史指标
   */
  async getHistoricalMetrics(
    instanceId: number,
    startTime: Date,
    endTime: Date,
    interval?: string
  ): Promise<MetricsRecord[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let sql = `
        SELECT id, instance_id, cpu_usage, memory_usage, disk_usage,
               connections, qps, tps, active_transactions, slow_queries,
               buffer_pool_hit_rate, threads_running, threads_connected,
               bytes_received, bytes_sent, queries_total, commits_total,
               rollbacks_total, metrics_data, recorded_at
        FROM metrics_history
        WHERE instance_id = ? AND recorded_at BETWEEN ? AND ?
        ORDER BY recorded_at ASC
        LIMIT 1000
      `;

      const params: any[] = [instanceId, startTime, endTime];

      // 如果指定了间隔，使用聚合
      if (interval) {
        sql = `
          SELECT
            MAX(id) as id,
            instance_id,
            AVG(cpu_usage) as cpu_usage,
            AVG(memory_usage) as memory_usage,
            AVG(disk_usage) as disk_usage,
            AVG(connections) as connections,
            AVG(qps) as qps,
            AVG(tps) as tps,
            AVG(active_transactions) as active_transactions,
            AVG(slow_queries) as slow_queries,
            AVG(buffer_pool_hit_rate) as buffer_pool_hit_rate,
            AVG(threads_running) as threads_running,
            AVG(threads_connected) as threads_connected,
            SUM(bytes_received) as bytes_received,
            SUM(bytes_sent) as bytes_sent,
            SUM(queries_total) as queries_total,
            SUM(commits_total) as commits_total,
            SUM(rollbacks_total) as rollbacks_total,
            DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:00') as recorded_at
          FROM metrics_history
          WHERE instance_id = ? AND recorded_at BETWEEN ? AND ?
          GROUP BY instance_id, DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:00')
          ORDER BY recorded_at ASC
        `;
      }

      const [rows] = await pool.execute(sql, params) as any;
      return rows as MetricsRecord[];
    } catch (error) {
      console.error('获取历史指标失败:', error);
      return [];
    }
  }

  /**
   * 获取历史指标（带时间范围参数）
   */
  async getHistoricalMetricsWithRange(
    instanceId: number,
    period: '1h' | '6h' | '24h' | '7d',
    interval: '1m' | '5m' | '15m' | '1h',
    metricIds?: string[]
  ): Promise<{ time: string[]; metrics: Record<string, number[]> }> {
    const pool = this.getPool();
    if (!pool) {
      return { time: [], metrics: {} };
    }

    const FIXED_COLUMNS = [
      'cpu_usage', 'memory_usage', 'disk_usage', 'connections',
      'qps', 'tps', 'active_transactions', 'slow_queries',
      'buffer_pool_hit_rate', 'threads_running', 'threads_connected',
    ] as const;

    // Validate all metric IDs against a safe identifier pattern to prevent SQL injection
    const SAFE_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const activeMetricIds = (metricIds && metricIds.length > 0 ? metricIds : [...FIXED_COLUMNS])
      .filter(id => SAFE_ID_RE.test(id));
    const fixedCols = activeMetricIds.filter(id => FIXED_COLUMNS.includes(id as any));
    const dynamicCols = activeMetricIds.filter(id => !FIXED_COLUMNS.includes(id as any));

    // Extended columns in the metrics_history table that have dedicated named columns
    // Used by COALESCE to bridge the gap between named column storage and metrics_data JSON
    const NAMED_EXTENDED_COLUMNS = new Set([
      'table_open_cache_hit_rate', 'handler_read_rnd_next', 'handler_read_rnd_next_rate',
      'key_blocks_usage', 'open_files', 'aborted_connects', 'aborted_connects_rate',
      'idx_scan_ratio', 'dead_tuples', 'cache_hit_ratio', 'connections_used', 'connections_max',
      'vacuum_count', 'autovacuum_count', 'replication_lag_seconds', 'data_size_gb',
    ]);

    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - this._periodToMs(period));

      const intervalMap: Record<string, string> = {
        '1m': '%Y-%m-%d %H:%i:00',
        '5m': '',
        '15m': '',
        '1h': '%Y-%m-%d %H:00:00',
      };
      const dateFormat = intervalMap[interval] || intervalMap['1m'];

      if (interval === '1m') {
        // 无聚合，直接查询原始数据
        const selectParts: string[] = ['recorded_at'];
        fixedCols.forEach(c => selectParts.push(c));
        dynamicCols.forEach(c => {
          const extract = NAMED_EXTENDED_COLUMNS.has(c)
            ? `COALESCE(JSON_EXTRACT(metrics_data, '$.${c}'), ${c})`
            : `JSON_EXTRACT(metrics_data, '$.${c}')`;
          selectParts.push(`${extract} as \`${c}\``);
        });

        const [rows] = await pool.execute(
          `SELECT ${selectParts.join(', ')}
           FROM metrics_history
           WHERE instance_id = ? AND recorded_at BETWEEN ? AND ?
           ORDER BY recorded_at ASC
           LIMIT 1000`,
          [instanceId, startTime, endTime]
        ) as any;

        const time: string[] = [];
        const metrics: Record<string, number[]> = {};
        activeMetricIds.forEach(k => { metrics[k] = []; });

        for (const row of rows) {
          time.push(this._formatRecordedAt(row.recorded_at));
          activeMetricIds.forEach(k => {
            metrics[k].push(Number(row[k]) || 0);
          });
        }

        return { time, metrics };
      }

      // 使用 DATE_FORMAT/FROM_UNIXTIME 聚合
      const selectParts: string[] = [];
      fixedCols.forEach(c => selectParts.push(`AVG(${c}) as \`${c}\``));
      dynamicCols.forEach(c => {
        const extract = NAMED_EXTENDED_COLUMNS.has(c)
          ? `AVG(COALESCE(JSON_EXTRACT(metrics_data, '$.${c}'), ${c}))`
          : `AVG(JSON_EXTRACT(metrics_data, '$.${c}'))`;
        selectParts.push(`${extract} as \`${c}\``);
      });

      // 5m/15m 使用 FLOOR 运算得到正确的分组桶
      let timeExpr: string;
      if (interval === '5m') {
        timeExpr = "FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / 300) * 300)";
      } else if (interval === '15m') {
        timeExpr = "FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / 900) * 900)";
      } else {
        timeExpr = `DATE_FORMAT(recorded_at, '${dateFormat}')`;
      }

      const [rows] = await pool.execute(
        `SELECT ${timeExpr} as time_str, ${selectParts.join(', ')}
         FROM metrics_history
         WHERE instance_id = ? AND recorded_at BETWEEN ? AND ?
         GROUP BY ${timeExpr}
         ORDER BY time_str ASC`,
        [instanceId, startTime, endTime]
      ) as any;

      const time: string[] = [];
      const metrics: Record<string, number[]> = {};
      activeMetricIds.forEach(k => { metrics[k] = []; });

      for (const row of rows) {
        time.push(row.time_str);
        activeMetricIds.forEach(k => {
          metrics[k].push(Number(row[k]) || 0);
        });
      }

      return { time, metrics };
    } catch (error) {
      console.error('获取历史指标范围失败:', error);
      return { time: [], metrics: {} };
    }
  }

  private _periodToMs(period: string): number {
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const map: Record<string, number> = {
      '1h': hour,
      '6h': 6 * hour,
      '24h': day,
      '7d': 7 * day,
    };
    return map[period] || hour;
  }

  private _formatRecordedAt(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}`;
  }

  /**
   * 清理过期指标
   */
  async cleanupOldMetrics(retentionDays: number = 30): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      await pool.execute(
        'DELETE FROM metrics_history WHERE recorded_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [retentionDays]
      );
    } catch (error) {
      console.error('清理过期指标失败:', error);
    }
  }

  /**
   * 记录慢查询
   */
  async recordSlowQuery(data: {
    instance_id: number;
    sql_text: string;
    sql_hash: string;
    avg_time_ms: number;
    max_time_ms: number;
    min_time_ms: number;
    execution_count: number;
    total_time_ms: number;
    rows_examined?: number;
    rows_sent?: number;
    digest_text?: string;
    schema_name?: string;
    user_name?: string;
    host_name?: string;
  }): Promise<{ success: boolean; queryId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 检查是否已存在
      const [existing] = await pool.execute(
        'SELECT id FROM slow_queries WHERE instance_id = ? AND sql_hash = ?',
        [data.instance_id, data.sql_hash]
      ) as any;

      if (existing && existing.length > 0) {
        // 更新现有记录
        await pool.execute(
          `UPDATE slow_queries SET
           avg_time_ms = ?, max_time_ms = ?, min_time_ms = ?,
           execution_count = execution_count + ?,
           total_time_ms = total_time_ms + ?,
           rows_examined = ?, rows_sent = ?,
           last_seen = NOW()
           WHERE instance_id = ? AND sql_hash = ?`,
          [
            data.avg_time_ms,
            data.max_time_ms,
            data.min_time_ms,
            data.execution_count,
            data.total_time_ms,
            data.rows_examined ?? 0,
            data.rows_sent ?? 0,
            data.instance_id,
            data.sql_hash,
          ]
        );
        return { success: true, queryId: existing[0].id };
      } else {
        // 插入新记录
        const [result] = await pool.execute(
          `INSERT INTO slow_queries
           (instance_id, sql_text, sql_hash, avg_time_ms, max_time_ms, min_time_ms,
            execution_count, total_time_ms, rows_examined, rows_sent,
            digest_text, schema_name, user_name, host_name, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            data.instance_id,
            data.sql_text,
            data.sql_hash,
            data.avg_time_ms,
            data.max_time_ms,
            data.min_time_ms,
            data.execution_count,
            data.total_time_ms,
            data.rows_examined ?? 0,
            data.rows_sent ?? 0,
            data.digest_text || null,
            data.schema_name || null,
            data.user_name || null,
            data.host_name || null,
          ]
        ) as any;

        return { success: true, queryId: result.insertId };
      }
    } catch (error: any) {
      console.error('记录慢查询失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取慢查询列表
   */
  async getSlowQueries(instanceId: number, limit: number = 20): Promise<SlowQueryRecord[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.query(
        `SELECT id, instance_id, sql_text, sql_hash, avg_time_ms, max_time_ms,
                min_time_ms, execution_count, total_time_ms, rows_examined,
                rows_sent, first_seen, last_seen, digest_text, schema_name,
                user_name, host_name, created_at, updated_at
         FROM slow_queries
         WHERE instance_id = ?
         ORDER BY avg_time_ms DESC
         LIMIT ?`,
        [instanceId, limit]
      ) as any;

      return rows as SlowQueryRecord[];
    } catch (error) {
      console.error('获取慢查询失败:', error);
      return [];
    }
  }

  /**
   * 记录故障诊断
   */
  async recordFaultDiagnosis(data: {
    instance_id: number;
    fault_type: string;
    fault_name: string;
    severity: string;
    confidence: number;
    diagnosis: string;
    evidence: any;
    solution?: string;
    auto_heal_possible?: boolean;
  }): Promise<{ success: boolean; diagnosisId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO fault_diagnoses
         (instance_id, fault_type, fault_name, severity, confidence,
          diagnosis, evidence, solution, auto_heal_possible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.instance_id,
          data.fault_type,
          data.fault_name,
          data.severity,
          data.confidence,
          data.diagnosis,
          JSON.stringify(data.evidence),
          data.solution || null,
          data.auto_heal_possible || false,
        ]
      ) as any;

      return { success: true, diagnosisId: result.insertId };
    } catch (error: any) {
      console.error('记录故障诊断失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取故障诊断列表
   */
  async getFaultDiagnoses(
    instanceId: number,
    limit: number = 10,
    offset: number = 0
  ): Promise<FaultDiagnosis[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, instance_id, fault_type, fault_name, severity,
                confidence, diagnosis, evidence, solution, status,
                auto_heal_possible, actions_taken, healed, healed_at,
                resolved_by, created_at, updated_at
         FROM fault_diagnoses
         WHERE instance_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [instanceId, limit, offset]
      ) as any;

      return rows as FaultDiagnosis[];
    } catch (error) {
      console.error('获取故障诊断列表失败:', error);
      return [];
    }
  }

  /**
   * 更新故障诊断状态
   */
  async updateFaultDiagnosisStatus(
    diagnosisId: number,
    status: string,
    actionsTaken?: any,
    resolvedBy?: number
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const updates: string[] = ['status = ?'];
      const values: any[] = [status];

      if (actionsTaken) {
        updates.push('actions_taken = ?');
        values.push(JSON.stringify(actionsTaken));
      }

      if (status === 'resolved') {
        updates.push('resolved_by = ?');
        values.push(resolvedBy || null);
        updates.push('updated_at = NOW()');
      }

      values.push(diagnosisId);

      await pool.execute(
        `UPDATE fault_diagnoses SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      return { success: true };
    } catch (error: any) {
      console.error('更新故障诊断状态失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 标记故障已自愈
   */
  async markFaultHealed(diagnosisId: number, actionsTaken: any[]): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'UPDATE fault_diagnoses SET healed = TRUE, healed_at = NOW(), actions_taken = ?, status = "resolved" WHERE id = ?',
        [JSON.stringify(actionsTaken), diagnosisId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('标记故障已自愈失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取故障历史统计
   */
  async getFaultHistoryStats(instanceId?: number): Promise<any> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      let sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN healed = TRUE THEN 1 ELSE 0 END) as healed
        FROM fault_diagnoses
      `;
      const params: any[] = [];

      if (instanceId) {
        sql += ' WHERE instance_id = ?';
        params.push(instanceId);
      }

      const [rows] = await pool.execute(sql, params) as any;
      return rows[0];
    } catch (error) {
      console.error('获取故障历史统计失败:', error);
      return null;
    }
  }

  /**
   * 记录容量数据（主记录 + 数据库明细）
   */
  async recordCapacity(data: {
    instance_id: number;
    total_size_gb: number;
    db_count?: number;
    table_count?: number;
    databases?: Array<{ name: string; size_gb: number; table_count?: number }>;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO capacity_history
         (instance_id, total_size_gb, db_count, table_count)
         VALUES (?, ?, ?, ?)`,
        [
          data.instance_id,
          data.total_size_gb,
          data.db_count ?? 0,
          data.table_count ?? 0,
        ]
      ) as any;

      const capacityId = result.insertId;

      // 写入数据库明细
      if (data.databases && data.databases.length > 0) {
        const placeholders = data.databases.map(() => '(?, ?, ?, ?, ?, NOW())').join(', ');
        const flatValues = data.databases.flatMap(db => [
          capacityId,
          data.instance_id,
          db.name,
          db.size_gb,
          db.table_count ?? 0,
        ]);

        await pool.execute(
          `INSERT INTO capacity_databases
           (capacity_id, instance_id, db_name, size_gb, table_count, recorded_at)
           VALUES ${placeholders}`,
          flatValues
        );
      }

      return { success: true };
    } catch (error: any) {
      console.error('记录容量数据失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取容量历史趋势
   */
  async getCapacityHistory(
    instanceId: number,
    hours: number = 24
  ): Promise<Array<{ total_size_gb: number; db_count: number; table_count: number; recorded_at: Date }>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT total_size_gb, db_count, table_count, recorded_at
         FROM capacity_history
         WHERE instance_id = ?
           AND recorded_at >= NOW() - INTERVAL ? HOUR
         ORDER BY recorded_at ASC`,
        [instanceId, hours]
      ) as any;

      return rows.map((row: any) => ({
        total_size_gb: Number(row.total_size_gb),
        db_count: Number(row.db_count),
        table_count: Number(row.table_count),
        recorded_at: new Date(row.recorded_at),
      }));
    } catch (error) {
      console.error('获取容量历史失败:', error);
      return [];
    }
  }

  /**
   * 获取容量数据库明细
   */
  async getCapacityDatabases(
    instanceId: number,
    recordedAt?: Date
  ): Promise<Array<{ db_name: string; size_gb: number; table_count: number }>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      if (recordedAt) {
        const [rows] = await pool.execute(
          `SELECT db_name, size_gb, table_count
           FROM capacity_databases
           WHERE instance_id = ? AND recorded_at = ?
           ORDER BY size_gb DESC`,
          [instanceId, recordedAt]
        ) as any;
        return rows.map((row: any) => ({
          db_name: row.db_name,
          size_gb: Number(row.size_gb),
          table_count: Number(row.table_count),
        }));
      } else {
        // 获取最新一条记录
        const [rows] = await pool.execute(
          `SELECT d.db_name, d.size_gb, d.table_count
           FROM capacity_databases d
           INNER JOIN capacity_history h ON d.capacity_id = h.id
           WHERE h.instance_id = ?
           ORDER BY h.recorded_at DESC
           LIMIT 100`,
          [instanceId]
        ) as any;
        return rows.map((row: any) => ({
          db_name: row.db_name,
          size_gb: Number(row.size_gb),
          table_count: Number(row.table_count),
        }));
      }
    } catch (error) {
      console.error('获取容量明细失败:', error);
      return [];
    }
  }
}

// 单例
export const metricsDatabaseService = new MetricsDatabaseService();
