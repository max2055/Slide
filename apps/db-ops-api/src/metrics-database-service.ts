/**
 * 监控指标数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';
import { withLegacyMetricWrite } from './metrics/rollout/legacy-write-fence.js';

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
  max_time_ms: number | null;
  min_time_ms: number | null;
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

export type SlowQueryReportRecord = Omit<SlowQueryRecord, 'avg_time_ms' | 'total_time_ms'> & {
  avg_time_ms: number | null;
  total_time_ms: number | null;
};

interface StrictReadOptions {
  strict?: boolean;
}

class MetricsDatabaseService {
  /**
   * 获取数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 写入历史指标，供迁移对照使用。
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
  }): Promise<{ success: boolean; error?: string; skipped?: 'source_fenced' }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const result = await withLegacyMetricWrite(pool, { type: 'instance', id: data.instance_id }, connection => connection.execute(
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
          data.cpu_usage ?? null,
          data.memory_usage ?? null,
          data.disk_usage ?? null,
          data.connections ?? null,
          data.qps ?? null,
          data.tps ?? null,
          data.active_transactions ?? null,
          data.slow_queries ?? null,
          data.buffer_pool_hit_rate ?? null,
          data.threads_running ?? null,
          data.threads_connected ?? null,
          data.bytes_received ?? null,
          data.bytes_sent ?? null,
          data.queries_total ?? null,
          data.commits_total ?? null,
          data.rollbacks_total ?? null,
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
        ],
      ));

      return result.written ? { success: true } : { success: true, skipped: 'source_fenced' };
    } catch (error: any) {
      console.error('记录监控指标失败:', error);
      return { success: false, error: error.message };
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
    max_time_ms: number | null;
    min_time_ms: number | null;
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

  /** 精确读取当前实例的慢查询；只有查询成功且无记录时返回 null。 */
  async getSlowQueryById(instanceId: number, slowQueryId: number): Promise<SlowQueryRecord | null> {
    const pool = this.getPool();
    if (!pool) throw new Error('SLOW_QUERIES_UNAVAILABLE');

    try {
      const [rows] = await pool.execute(
        `SELECT id, instance_id, sql_text, sql_hash, avg_time_ms, max_time_ms,
                min_time_ms, execution_count, total_time_ms, rows_examined,
                rows_sent, first_seen, last_seen, digest_text, schema_name,
                user_name, host_name, created_at, updated_at
         FROM slow_queries
         WHERE instance_id = ? AND id = ?`,
        [instanceId, slowQueryId],
      ) as [SlowQueryRecord[], unknown];
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        avg_time_ms: Number(row.avg_time_ms),
        max_time_ms: row.max_time_ms == null ? null : Number(row.max_time_ms),
        min_time_ms: row.min_time_ms == null ? null : Number(row.min_time_ms),
        total_time_ms: Number(row.total_time_ms),
      };
    } catch (error) {
      throw new Error('SLOW_QUERIES_QUERY_FAILED', { cause: error });
    }
  }

  /**
   * 获取慢查询列表
   */
  async getSlowQueries(
    instanceId: number, limit: number, options: StrictReadOptions & { preserveUnknownDurations: true },
  ): Promise<SlowQueryReportRecord[]>;
  async getSlowQueries(instanceId: number, limit?: number, options?: StrictReadOptions): Promise<SlowQueryRecord[]>;
  async getSlowQueries(
    instanceId: number,
    limit: number = 20,
    options: StrictReadOptions & { preserveUnknownDurations?: true } = {},
  ): Promise<SlowQueryReportRecord[]> {
    const pool = this.getPool();
    if (!pool) {
      if (options.strict) throw new Error('SLOW_QUERIES_UNAVAILABLE');
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

      // mysql2 returns DECIMAL strings. Reports distinguish unknown durations
      // from measured zero while existing consumers keep their numeric reads.
      return rows.map((row: SlowQueryReportRecord) => ({
        ...row,
        avg_time_ms: options.preserveUnknownDurations && row.avg_time_ms == null ? null : Number(row.avg_time_ms),
        max_time_ms: row.max_time_ms == null ? null : Number(row.max_time_ms),
        min_time_ms: row.min_time_ms == null ? null : Number(row.min_time_ms),
        total_time_ms: options.preserveUnknownDurations && row.total_time_ms == null ? null : Number(row.total_time_ms),
      }));
    } catch (error) {
      console.error('获取慢查询失败:', error);
      if (options.strict) throw new Error('SLOW_QUERIES_QUERY_FAILED', { cause: error });
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

    let connection: mysql.PoolConnection | undefined;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO capacity_history
         (instance_id, total_size_gb, db_count, table_count)
         VALUES (?, ?, ?, ?)`,
        [
          data.instance_id,
          data.total_size_gb,
          data.db_count ?? data.databases?.length ?? 0,
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

        await connection.execute(
          `INSERT INTO capacity_databases
           (capacity_id, instance_id, db_name, size_gb, table_count, recorded_at)
           VALUES ${placeholders}`,
          flatValues
        );
      }

      await connection.commit();
      return { success: true };
    } catch (error: any) {
      if (connection) {
        try { await connection.rollback(); } catch { connection.destroy(); }
      }
      console.error('记录容量数据失败:', error);
      return { success: false, error: error.message };
    } finally {
      connection?.release();
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
      throw new Error('SOURCE_CAPACITY_HISTORY_READ_FAILED');
    }

    try {
      const [rows] = await pool.execute(
        `SELECT total_size_gb, db_count, table_count, recorded_at
         FROM capacity_history h
         WHERE h.instance_id = ?
           AND h.recorded_at >= NOW() - INTERVAL ? HOUR
           AND (COALESCE(h.db_count, 0) <= 0 OR h.db_count = (
             SELECT COUNT(*) FROM capacity_databases d
             WHERE d.capacity_id = h.id AND d.instance_id = h.instance_id
           ))
         ORDER BY h.recorded_at ASC, h.id ASC`,
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
      throw new Error('SOURCE_CAPACITY_HISTORY_READ_FAILED');
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
      throw new Error('SOURCE_CAPACITY_DETAILS_READ_FAILED');
    }

    try {
      // 仅跳过数量明确不符的旧半快照；旧记录默认/空数量无法证明失败，
      // 必须保留，尤其不能将合法零库快照回退到历史明细。
      // 时间查询同样按汇总时间和 id 选一批，避免同秒采集混入多份明细。
      const [rows] = await pool.execute(
        `SELECT d.db_name, d.size_gb, d.table_count
         FROM capacity_databases d
         WHERE d.capacity_id = (
           SELECT h.id FROM capacity_history h
           WHERE h.instance_id = ?
             ${recordedAt ? 'AND h.recorded_at = ?' : ''}
             AND (COALESCE(h.db_count, 0) <= 0 OR h.db_count = (
               SELECT COUNT(*) FROM capacity_databases complete
               WHERE complete.capacity_id = h.id AND complete.instance_id = h.instance_id
             ))
           ORDER BY h.recorded_at DESC, h.id DESC
           LIMIT 1
         ) AND d.instance_id = ?
         ORDER BY d.size_gb DESC, d.db_name ASC, d.id ASC`,
        recordedAt ? [instanceId, recordedAt, instanceId] : [instanceId, instanceId]
      ) as any;
      return rows.map((row: any) => ({
        db_name: row.db_name,
        size_gb: Number(row.size_gb),
        table_count: Number(row.table_count),
      }));
    } catch (error) {
      console.error('获取容量明细失败:', error);
      throw new Error('SOURCE_CAPACITY_DETAILS_READ_FAILED');
    }
  }
}

// 单例
export const metricsDatabaseService = new MetricsDatabaseService();
