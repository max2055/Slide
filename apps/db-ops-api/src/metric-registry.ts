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
  target_type?: 'instance' | 'server' | 'network_device';
}

/**
 * 指标注册表类
 *
 * 使用 Map 存储所有指标定义，提供类型安全的查询接口。
 */
export class MetricRegistry {
  private definitions: Map<string, MetricDefinition>;

  private definitionKey(metric: Pick<MetricDefinition, 'id' | 'target_type'>): string {
    return `${metric.target_type ?? 'instance'}:${metric.id}`;
  }

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
        const definition = this._rowToDefinition(row);
        this.definitions.set(this.definitionKey(definition), definition);
      }
      const predefined = this._getPredefinedMetrics();
      for (const m of predefined) {
        const existing = this.definitions.get(this.definitionKey(m));
        if (!existing) {
          this.definitions.set(this.definitionKey(m), m);
        } else if (m.is_builtin && existing.is_builtin) {
          // Older seeded rows must not hide newly supported database engines.
          // Preserve operator intervals, enabled flags and SQL overrides.
          existing.db_types = [...new Set([...existing.db_types, ...m.db_types])];
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
          target_type: m.target_type,
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
      target_type: row.target_type === 'server' ? 'server' : row.target_type === 'network_device' ? 'network_device' : row.target_type === 'instance' ? 'instance' : undefined,
    };
  }

  private _getPredefinedMetrics(): MetricDefinition[] {
    // ServerCollector persists these OS-level samples directly. Keep their
    // registry metadata in lockstep so alerting and resource APIs can resolve
    // every emitted metric name (including dimensional counter samples).
    const serverMetric = (
      id: string,
      name: string,
      description: string,
      unit: string,
      options: Partial<Pick<MetricDefinition, 'aggregation' | 'value_type' | 'higher_is_worse' | 'threshold_template'>> = {},
    ): MetricDefinition => ({
      id,
      name,
      description,
      unit,
      db_types: [],
      aggregation: options.aggregation ?? 'last',
      default_interval: 300,
      is_collected: true,
      is_builtin: true,
      category: 'server',
      value_type: options.value_type ?? 'gauge',
      higher_is_worse: options.higher_is_worse,
      threshold_template: options.threshold_template ?? null,
      target_type: 'server',
    });

    const emittedServerMetrics: MetricDefinition[] = [
      serverMetric('network_rx_bytes', '网络接收字节数', '服务器网络接口接收字节累计值', 'bytes'),
      serverMetric('network_tx_bytes', '网络发送字节数', '服务器网络接口发送字节累计值', 'bytes'),
      serverMetric('network_rx_errors', '网络接收错误数', '服务器网络接口接收错误累计值', 'count', { value_type: 'counter', higher_is_worse: true }),
      serverMetric('network_tx_errors', '网络发送错误数', '服务器网络接口发送错误累计值', 'count', { value_type: 'counter', higher_is_worse: true }),
      serverMetric('network_rx_drops', '网络接收丢弃数', '服务器网络接口接收丢弃累计值', 'count', { value_type: 'counter', higher_is_worse: true }),
      serverMetric('network_tx_drops', '网络发送丢弃数', '服务器网络接口发送丢弃累计值', 'count', { value_type: 'counter', higher_is_worse: true }),
      serverMetric('disk_read_bytes', '磁盘读取字节数', '服务器块设备读取扇区转换后的累计字节数', 'bytes', { value_type: 'counter' }),
      serverMetric('disk_write_bytes', '磁盘写入字节数', '服务器块设备写入扇区转换后的累计字节数', 'bytes', { value_type: 'counter' }),
      serverMetric('disk_io_time_ms', '磁盘 I/O 时间', '服务器块设备累计执行 I/O 时间', 'ms', { value_type: 'counter', higher_is_worse: true }),
      serverMetric('process_count', '进程数', '服务器当前进程数量', 'count', { higher_is_worse: true }),
      serverMetric('top_processes_cpu', '最高进程 CPU 使用率', '服务器进程列表中的最高 CPU 使用率', '%', { aggregation: 'max', higher_is_worse: true, threshold_template: { warning: 80, error: 90, critical: 95 } }),
      serverMetric('top_processes_memory', '最高进程内存使用率', '服务器进程列表中的最高内存使用率', '%', { aggregation: 'max', higher_is_worse: true, threshold_template: { warning: 80, error: 90, critical: 95 } }),
    ];

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
        is_collected: false,
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
      // ===== Server OS-level metrics (target_type: 'server') =====
      {
        id: 'cpu_usage',
        name: 'CPU 使用率(OS)',
        description: '服务器操作系统级 CPU 使用率',
        unit: '%',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
        threshold_template: { warning: 80, error: 90, critical: 95 },
      },
      {
        id: 'memory_usage',
        name: '内存使用率(OS)',
        description: '服务器操作系统级内存使用率',
        unit: '%',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
        threshold_template: { warning: 80, error: 90, critical: 95 },
      },
      {
        id: 'memory_used',
        name: '已用内存(OS)',
        description: '服务器操作系统已使用内存',
        unit: 'bytes',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'memory_total',
        name: '总内存(OS)',
        description: '服务器操作系统物理内存总量',
        unit: 'bytes',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'disk_usage',
        name: '磁盘使用率(OS)',
        description: '服务器磁盘使用率（各挂载点聚合）',
        unit: '%',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
        threshold_template: { warning: 75, error: 85, critical: 95 },
      },
      {
        id: 'filesystem_size_bytes',
        name: 'Filesystem size',
        description: 'Total filesystem capacity reported by the server OS',
        unit: 'bytes',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'filesystem_used_bytes',
        name: 'Filesystem used',
        description: 'Used filesystem capacity reported by the server OS',
        unit: 'bytes',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'filesystem_available_bytes',
        name: 'Filesystem available',
        description: 'Available filesystem capacity reported by the server OS',
        unit: 'bytes',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'filesystem_inode_usage',
        name: 'Filesystem inode usage',
        description: 'Filesystem inode utilization reported by the server OS',
        unit: '%',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
        threshold_template: { warning: 75, error: 85, critical: 95 },
      },
      {
        id: 'load_1min',
        name: '系统负载(1min)',
        description: '系统 1 分钟平均负载',
        unit: 'load',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
        threshold_template: { warning: 4, error: 8, critical: 12 },
      },
      {
        id: 'load_5min',
        name: '系统负载(5min)',
        description: '系统 5 分钟平均负载',
        unit: 'load',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'load_15min',
        name: '系统负载(15min)',
        description: '系统 15 分钟平均负载',
        unit: 'load',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'swap_usage',
        name: 'Swap 使用率',
        description: '服务器 Swap 使用率',
        unit: '%',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
        threshold_template: { warning: 50, error: 80, critical: 90 },
      },
      {
        id: 'uptime',
        name: '运行时间',
        description: '服务器连续运行时间（秒）',
        unit: 'seconds',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      {
        id: 'os_type',
        name: '操作系统类型',
        description: '服务器操作系统类型标识',
        unit: 'string',
        db_types: [],
        aggregation: 'last',
        default_interval: 3600,
        is_collected: true,
        is_builtin: true,
        category: 'server',
        target_type: 'server',
      },
      ...emittedServerMetrics,
      // ===== Huawei network-device metrics =====
      {
        id: 'device_reachability',
        name: '设备可达性',
        description: '设备最近一次 SNMPv3 采集是否可达（1=可达，0=不可达）',
        unit: 'state',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'gauge',
        higher_is_worse: false,
        threshold_template: { warning: 0, error: 0, critical: 0 },
        target_type: 'network_device',
      },
      {
        id: 'device_uptime_seconds',
        name: '设备运行时间',
        description: '华为 VRP 设备 SNMPv3 sysUpTime（秒）',
        unit: 'seconds',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'gauge',
        target_type: 'network_device',
      },
      {
        id: 'device_cpu_percent',
        name: '设备 CPU 使用率',
        description: '华为 VRP 设备 CPU 使用率',
        unit: '%',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'gauge',
        higher_is_worse: true,
        threshold_template: { warning: 80, error: 90, critical: 95 },
        target_type: 'network_device',
      },
      {
        id: 'device_memory_percent',
        name: '设备内存使用率',
        description: '华为 VRP 设备内存使用率',
        unit: '%',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'gauge',
        higher_is_worse: true,
        threshold_template: { warning: 80, error: 90, critical: 95 },
        target_type: 'network_device',
      },
      {
        id: 'device_temperature_celsius',
        name: '设备温度',
        description: '华为 VRP 设备温度',
        unit: '°C',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'gauge',
        higher_is_worse: true,
        threshold_template: { warning: 70, error: 80, critical: 90 },
        target_type: 'network_device',
      },
      {
        id: 'interface_oper_status',
        name: '接口运行状态',
        description: '接口 operStatus，1 表示 up，0 表示 down',
        unit: 'state',
        db_types: [],
        aggregation: 'last',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'gauge',
        higher_is_worse: false,
        threshold_template: { warning: 0, error: 0, critical: 0 },
        target_type: 'network_device',
      },
      {
        id: 'interface_error_rate',
        name: '接口错误速率',
        description: '接口入方向错误包速率',
        unit: 'errors/s',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'counter',
        higher_is_worse: true,
        threshold_template: { warning: 1, error: 10, critical: 100 },
        target_type: 'network_device',
      },
      {
        id: 'interface_drop_rate',
        name: '接口丢弃速率',
        description: '接口入方向丢弃包速率',
        unit: 'drops/s',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'counter',
        higher_is_worse: true,
        threshold_template: { warning: 1, error: 10, critical: 100 },
        target_type: 'network_device',
      },
      {
        id: 'interface_in_bps',
        name: '接口入流量',
        description: '接口入方向比特速率',
        unit: 'bits/s',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'counter',
        target_type: 'network_device',
      },
      {
        id: 'interface_out_bps',
        name: '接口出流量',
        description: '接口出方向比特速率',
        unit: 'bits/s',
        db_types: [],
        aggregation: 'avg',
        default_interval: 300,
        is_collected: true,
        is_builtin: true,
        category: 'network_device',
        value_type: 'counter',
        target_type: 'network_device',
      },
    ];
  }

  private loadPredefinedMetrics(): void {
    const metrics = this._getPredefinedMetrics();
    for (const metric of metrics) {
      this.definitions.set(this.definitionKey(metric), metric);
    }
  }

  /**
   * 获取所有已注册的指标定义
   * @param targetType 可选 — 指定 target_type 过滤，不传则返回全部
   */
  getAll(targetType?: string): MetricDefinition[] {
    if (targetType) {
      return Array.from(this.definitions.values()).filter(
        (m) => (m.target_type ?? 'instance') === targetType
      );
    }
    return Array.from(this.definitions.values());
  }

  /**
   * 获取指定 ID 的指标定义
   * @param id 指标 ID
   * @returns MetricDefinition 或 null
   */
  getById(id: string, targetType: 'instance' | 'server' | 'network_device' = 'instance'): MetricDefinition | null {
    return this.definitions.get(`${targetType}:${id}`) ?? null;
  }

  /**
   * 获取指定 target_type 的指标定义
   * @param targetType 目标类型 'instance' 或 'server'
   * @returns 匹配的指标定义列表
   */
  getByTargetType(targetType: string): MetricDefinition[] {
    return this.getAll(targetType);
  }

  /**
   * 获取适用于指定数据库类型的指标
   * @param dbType 数据库类型
   * @returns 匹配的指标定义列表
   */
  getByDbType(dbType: string): MetricDefinition[] {
    return this.getAll('instance').filter((m) => m.db_types.includes(dbType));
  }

  /**
   * 检查指标 ID 是否在注册表中
   * @param id 指标 ID
   * @returns 是否存在
   */
  isValidMetric(id: string, targetType: 'instance' | 'server' | 'network_device' = 'instance'): boolean {
    return this.definitions.has(`${targetType}:${id}`);
  }

  /**
   * 获取所有指标 ID 列表
   * @returns 指标 ID 数组
   */
  getMetricIds(): string[] {
    return Array.from(this.definitions.values()).map((metric) => metric.id);
  }
}

// 单例导出
export const metricRegistry = new MetricRegistry();
