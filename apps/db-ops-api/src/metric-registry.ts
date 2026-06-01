/**
 * 指标注册表 - 类型安全的指标定义管理
 *
 * 提供统一的指标定义注册表，包含所有预定义指标的元数据。
 * 服务启动时从数据库加载，DB 不可用时 fallback 到内存预定义。
 */
import { metricDatabaseService, MetricDefinitionRow } from './metric-database-service';

/**
 * 指标定义接口
 */
export interface MetricDefinition {
  id: string;
  name: string;
  description: string;
  unit: string;
  db_types: string[];
  aggregation: 'avg' | 'max' | 'min' | 'sum' | 'last';
  default_interval: number;
  is_collected: boolean;
  is_builtin: boolean;
  collection_sqls?: Record<string, string>;
  compute_expr?: string;
  category?: string;
  value_type?: 'gauge' | 'counter' | 'histogram';
  higher_is_worse?: boolean;
  threshold_template?: { warning: number; error: number; critical: number } | null;
}

/**
 * 指标注册表类
 *
 * 使用 Map 存储所有指标定义，提供类型安全的查询接口。
 */
export class MetricRegistry {
  private definitions: Map<string, MetricDefinition>;

  constructor() {
    this.definitions = new Map();
    this.loadPredefinedMetrics();
  }

  /**
   * 从数据库加载指标定义，DB 不可用时 fallback 到预定义
   */
  async initialize(): Promise<void> {
    try {
      let rows = await metricDatabaseService.getAllMetrics();
      console.log(`[MetricRegistry] initialize: DB returned ${rows.length} rows`);
      if (rows.length === 0) {
        console.log('[MetricRegistry] DB empty, seeding predefined metrics...');
        await this._seedPredefinedToDB();
        rows = await metricDatabaseService.getAllMetrics();
        console.log(`[MetricRegistry] after seed: ${rows.length} rows`);
      }
      // Load DB rows into memory, then fill gaps with predefined defaults
      this.definitions.clear();
      for (const row of rows) {
        this.definitions.set(row.id, this._rowToDefinition(row));
      }
      const predefined = this._getPredefinedMetrics();
      for (const m of predefined) {
        if (!this.definitions.has(m.id)) {
          this.definitions.set(m.id, m);
        }
      }
      console.log(`[MetricRegistry] loaded ${this.definitions.size} definitions (${rows.length} DB + ${this.definitions.size - rows.length} predefined)`);
      return;
    } catch (e) {
      console.warn('[MetricRegistry] DB 不可用，使用预定义指标:', (e as Error).message);
    }
    // Last-resort fallback (DB completely unavailable)
    this.loadPredefinedMetrics();
    console.log(`[MetricRegistry] fallback: loaded ${this.definitions.size} predefined`);
  }

  private async _seedPredefinedToDB(): Promise<void> {
    const metrics = this._getPredefinedMetrics();
    let ok = 0, fail = 0;
    for (const m of metrics) {
      try {
        const r = await metricDatabaseService.createMetric({
          id: m.id, name: m.name, description: m.description, unit: m.unit,
          db_types: m.db_types, aggregation: m.aggregation,
          default_interval: m.default_interval,
          is_collected: m.is_collected,
        });
        if (r.success) ok++; else { fail++; console.warn(`[MetricRegistry] seed ${m.id} failed: ${r.error}`); }
      } catch (e) { fail++; console.warn(`[MetricRegistry] seed ${m.id} error:`, (e as Error).message); }
    }
    console.log(`[MetricRegistry] seeded ${ok} metrics, ${fail} failed`);
  }

  /**
   * 刷新内存缓存（在 POST/PUT/DELETE 写操作后调用）
   */
  async refreshFromDB(): Promise<void> {
    const oldDefs = this.definitions;
    this.definitions = new Map(); // swap to empty map, advance concurrently
    try {
      await this.initialize(); // populates this.definitions with fresh data
    } catch {
      // Restore previous state on failure so readers see stale data rather than empty
      this.definitions = oldDefs;
    }
  }

  /**
   * 将数据库行转换为 MetricDefinition
   */
  private _rowToDefinition(row: MetricDefinitionRow): MetricDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      unit: row.unit,
      db_types: typeof row.db_types === 'string' ? JSON.parse(row.db_types) : row.db_types,
      aggregation: row.aggregation as MetricDefinition['aggregation'],
      default_interval: row.default_interval,
      is_collected: !!row.is_collected,
      is_builtin: !!row.is_builtin,
      collection_sqls: row.collection_sqls
        ? (typeof row.collection_sqls === 'string' ? JSON.parse(row.collection_sqls) : row.collection_sqls)
        : undefined,
      compute_expr: row.compute_expr || undefined,
      category: row.category || undefined,
      value_type: row.value_type || 'gauge',
      threshold_template: row.threshold_template
        ? (typeof row.threshold_template === 'string' ? JSON.parse(row.threshold_template) : row.threshold_template)
        : null,
    };
  }

  private _getPredefinedMetrics(): MetricDefinition[] {
    return [
      {
        id: 'cpu_usage',
        name: 'CPU 使用率（估算）',
        description: '数据库实例的 CPU 使用率（基于线程数和活跃事务加权估算，非 OS 级真实 CPU）',
        unit: '%',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 80, error: 90, critical: 95 },
      },
      {
        id: 'memory_usage',
        name: '内存使用率（估算）',
        description: '数据库实例的内存使用率（基于 InnoDB buffer pool + key buffer 估算，非 OS 级真实内存）',
        unit: '%',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 80, error: 90, critical: 95 },
      },
      {
        id: 'disk_usage',
        name: '磁盘使用率（估算）',
        description: '数据库实例的磁盘使用率（基于 information_schema.tables 数据大小估算）',
        unit: '%',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 75, error: 85, critical: 95 },
      },
      {
        id: 'connections',
        name: '活跃连接数',
        description: '当前活跃数据库连接数',
        unit: 'count',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'max',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 80, error: 150, critical: 200 },
      },
      {
        id: 'qps',
        name: '每秒查询数',
        description: '数据库每秒处理的查询数量（delta 计算）',
        unit: 'ops/s',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 1000, error: 5000, critical: 10000 },
      },
      {
        id: 'tps',
        name: '每秒事务数',
        description: '数据库每秒处理的事务数量（delta 计算）',
        unit: 'ops/s',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 500, error: 2000, critical: 5000 },
      },
      {
        id: 'slow_queries',
        name: '慢查询数',
        description: '统计周期内的慢查询数量',
        unit: 'count',
        db_types: ['mysql', 'postgresql', 'oracle'],
        aggregation: 'sum',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 10, error: 50, critical: 100 },
      },
      {
        id: 'buffer_pool_hit_rate',
        name: '缓冲池命中率',
        description: 'InnoDB 缓冲池命中率（越高越好）',
        unit: '%',
        db_types: ['mysql'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 95, error: 90, critical: 80 },
      },
      {
        id: 'health_score',
        name: '健康评分',
        description: '数据库实例综合健康评分（越高越好）',
        unit: 'score',
        db_types: ['mysql', 'postgresql', 'dameng', 'oracle'],
        aggregation: 'last',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 70, error: 50, critical: 30 },
      },
      // MySQL 扩增指标
      {
        id: 'table_open_cache_hit_rate',
        name: '表缓存命中率',
        description: 'Table Open Cache 命中率（越高越好）',
        unit: '%',
        db_types: ['mysql'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 95, error: 90, critical: 80 },
      },
      {
        id: 'handler_read_rnd_next',
        name: '全表扫次数',
        description: 'Handler_read_rnd_next 累计值，高值提示大量全表扫',
        unit: 'count',
        db_types: ['mysql'],
        aggregation: 'sum',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 100000, error: 500000, critical: 1000000 },
      },
      {
        id: 'handler_read_rnd_next_rate',
        name: '全表扫速率',
        description: '全表扫速率（次/秒）',
        unit: 'ops/s',
        db_types: ['mysql'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 100, error: 500, critical: 1000 },
      },
      {
        id: 'key_blocks_usage',
        name: 'Key Buffer 使用率',
        description: 'MyISAM Key Buffer 使用率',
        unit: '%',
        db_types: ['mysql'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 80, error: 90, critical: 95 },
      },
      {
        id: 'open_files',
        name: '打开文件数',
        description: '当前打开文件数',
        unit: 'count',
        db_types: ['mysql'],
        aggregation: 'last',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 5000, error: 8000, critical: 10000 },
      },
      {
        id: 'aborted_connects',
        name: '拒绝连接数',
        description: '拒绝连接累计次数',
        unit: 'count',
        db_types: ['mysql'],
        aggregation: 'sum',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 10, error: 50, critical: 100 },
      },
      {
        id: 'aborted_connects_rate',
        name: '拒绝连接速率',
        description: '拒绝连接速率（次/秒）',
        unit: 'ops/s',
        db_types: ['mysql'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 1, error: 5, critical: 10 },
      },
      // PostgreSQL 扩增指标
      {
        id: 'idx_scan_ratio',
        name: '索引扫描比例',
        description: '索引扫描占比（越高越好）',
        unit: '%',
        db_types: ['postgresql'],
        aggregation: 'avg',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 90, error: 80, critical: 50 },
      },
      {
        id: 'dead_tuples',
        name: '死元组数',
        description: '死元组总数（需要 vacuum 清理）',
        unit: 'count',
        db_types: ['postgresql'],
        aggregation: 'last',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 10000, error: 50000, critical: 100000 },
      },
      {
        id: 'cache_hit_ratio',
        name: '缓冲命中率',
        description: '共享缓冲区命中率（越高越好）',
        unit: '%',
        db_types: ['postgresql'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 95, error: 90, critical: 80 },
      },
      {
        id: 'connections_used',
        name: '连接使用数',
        description: '当前使用连接数',
        unit: 'count',
        db_types: ['postgresql'],
        aggregation: 'last',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 80, error: 100, critical: 150 },
      },
      {
        id: 'vacuum_count',
        name: 'Vacuum 次数',
        description: '手动 Vacuum 运行次数（诊断指标，不触发告警）',
        unit: 'count',
        db_types: ['postgresql'],
        aggregation: 'sum',
        default_interval: 300,
        is_collected: false,
        is_builtin: true,
        threshold_template: { warning: 0, error: 0, critical: 0 },
      },
      {
        id: 'autovacuum_count',
        name: 'AutoVacuum 次数',
        description: '自动 Vacuum 运行次数（诊断指标，不触发告警）',
        unit: 'count',
        db_types: ['postgresql'],
        aggregation: 'sum',
        default_interval: 300,
        is_collected: false,
        is_builtin: true,
        threshold_template: { warning: 0, error: 0, critical: 0 },
      },
      {
        id: 'replication_lag_seconds',
        name: '复制延迟',
        description: '主从复制延迟（秒）',
        unit: 'seconds',
        db_types: ['postgresql'],
        aggregation: 'last',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 5, error: 30, critical: 60 },
      },
      // 通用扩增指标
      {
        id: 'data_size_gb',
        name: '数据大小',
        description: '数据库数据总大小（GB）',
        unit: 'GB',
        db_types: ['mysql', 'postgresql'],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 100, error: 500, critical: 1000 },
      },
      // Oracle 专属指标 (D-02)
      {
        id: 'tablespace_usage',
        name: '表空间使用率',
        description: '表空间使用率（基于 DBA_DATA_FILES）',
        unit: '%',
        db_types: ['oracle'],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 80, error: 90, critical: 95 },
      },
      {
        id: 'sga_hit_rate',
        name: 'SGA 命中率',
        description: '系统全局区命中率（Library Cache + Buffer Cache）',
        unit: '%',
        db_types: ['oracle'],
        aggregation: 'avg',
        default_interval: 30,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 95, error: 90, critical: 80 },
      },
      {
        id: 'deadlock_count',
        name: '死锁数',
        description: '死锁检测次数',
        unit: 'count',
        db_types: ['oracle'],
        aggregation: 'max',
        default_interval: 60,
        is_collected: true,
        is_builtin: true,
        threshold_template: { warning: 5, error: 10, critical: 20 },
      },
    ];

    for (const metric of metrics) {
      this.definitions.set(metric.id, metric);
    }
  }

  private loadPredefinedMetrics(): void {
    const metrics = this._getPredefinedMetrics();
    for (const metric of metrics) {
      this.definitions.set(metric.id, metric);
    }
  }

  /**
   * 获取所有已注册的指标定义
   */
  getAll(): MetricDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * 获取指定 ID 的指标定义
   * @param id 指标 ID
   * @returns MetricDefinition 或 null
   */
  getById(id: string): MetricDefinition | null {
    return this.definitions.get(id) ?? null;
  }

  /**
   * 获取适用于指定数据库类型的指标
   * @param dbType 数据库类型
   * @returns 匹配的指标定义列表
   */
  getByDbType(dbType: string): MetricDefinition[] {
    return this.getAll().filter((m) => m.db_types.includes(dbType));
  }

  /**
   * 检查指标 ID 是否在注册表中
   * @param id 指标 ID
   * @returns 是否存在
   */
  isValidMetric(id: string): boolean {
    return this.definitions.has(id);
  }

  /**
   * 获取所有指标 ID 列表
   * @returns 指标 ID 数组
   */
  getMetricIds(): string[] {
    return Array.from(this.definitions.keys());
  }
}

// 单例导出
export const metricRegistry = new MetricRegistry();
