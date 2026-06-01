/**
 * 数据库服务模块 - 真实的数据库连接和数据采集
 */
import mysql, { RowDataPacket } from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import oracledb from 'oracledb';
import dmdb from 'dmdb';
import { calculateDimensionScores } from './scoring-service.js';
import { scoringConfigService } from './scoring-config-service.js';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  db_type?: string;  // 数据库类型
}

export interface DatabaseConnection {
  id: number;
  name: string;
  config: DatabaseConfig;
  pool: mysql.Pool | null;
  pgClient: PgClient | null;  // PostgreSQL 客户端
  oracleConnection: oracledb.Connection | null;  // Oracle 连接 (persistent from pool)
  oraclePool: oracledb.Pool | null;  // Oracle 连接池
  dmConnection: dmdb.Connection | null;  // 达梦数据库连接
  connected: boolean;
  db_type: string;  // 数据库类型
  deltaCounter?: {
    queries: number;
    commits: number;
    rollbacks: number;
    bytesReceived: number;
    bytesSent: number;
    slowQueries: number;
    abortedConnects: number;
    handlerReadRndNext: number;
    timestamp: number;
  };
  pgDeltaCounter?: {
    xactCommit: number;
    xactRollback: number;
    blksRead: number;
    blksHit: number;
    timestamp: number;
  };
  oracleDeltaCounter?: {
    executes: number;
    commits: number;
    timestamp: number;
  };
}

export interface RealtimeMetrics {
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  connections: number;
  max_connections?: number;
  qps: number;
  tps: number;
  active_transactions: number;
  slow_queries: number;
  db_type?: string;  // 数据库类型
  // MySQL 特有指标
  innodb_buffer_pool_hit_rate?: number;  // InnoDB 缓冲池命中率
  innodb_row_lock_time_avg?: number;     // 行锁等待平均时间 (ms)
  innodb_deadlocks?: number;              // 死锁数量
  tmp_table_on_disk?: number;             // 磁盘临时表数量
  thread_cache_hit_rate?: number;         // 线程缓存命中率
  replication_lag?: number;               // 复制延迟 (秒)
  replication_status?: 'running' | 'stopped' | 'error';  // 复制状态
  uptime_seconds?: number;                // 运行时间
  version?: string;                       // 数据库版本
  // PostgreSQL 特有指标
  cache_hit_rate?: number;                // 缓存命中率
  xact_commit?: number;                   // 事务提交数
  xact_rollback?: number;                 // 事务回滚数
  tup_returned?: number;                  // 返回行数
  tup_fetched?: number;                   // 抓取行数
  tup_inserted?: number;                  // 插入行数
  tup_updated?: number;                   // 更新行数
  tup_deleted?: number;                   // 删除行数
  blk_read?: number;                      // 磁盘读取块数
  blk_hit?: number;                       // 缓存命中块数
  temp_files?: number;                    // 临时文件数量
  deadlock_count?: number;                // 死锁数量
  lock_wait_count?: number;               // 锁等待数量
  // Oracle 特有指标
  pga_cache_hit_rate?: number;            // PGA 缓存命中率
  library_cache_hit_rate?: number;        // 库缓存命中率
  shared_pool_hit_rate?: number;          // 共享池命中率
  enqueue_deadlocks?: number;             // 队列死锁数量
  tablespace_usage_percent?: number;      // 表空间使用率
  active_sessions?: number;               // 活动会话数
  sga_size_mb?: number;                   // SGA 大小 (MB)
  pga_size_mb?: number;                   // PGA 大小 (MB)
  // 达梦特有指标
  dm_buffer_hit_rate?: number;            // 缓冲池命中率
  dm_lock_wait?: number;                  // 锁等待数量
  dm_deadlock_count?: number;             // 死锁数量
  dm_paged_memory_usage?: number;         // 页内存使用
  dm_os_memory_usage?: number;            // 操作系统内存使用
  // MySQL 扩增指标
  table_open_cache_hit_rate?: number;
  handler_read_rnd_next?: number;
  handler_read_rnd_next_rate?: number;
  key_blocks_usage?: number;
  open_files?: number;
  aborted_connects?: number;
  aborted_connects_rate?: number;
  // PostgreSQL 扩增指标
  idx_scan_ratio?: number;
  dead_tuples?: number;
  connections_used?: number;
  connections_max?: number;
  vacuum_count?: number;
  autovacuum_count?: number;
  replication_lag_seconds?: number;
  // 通用
  data_size_gb?: number;
  is_estimated?: boolean;
  // 累计值（用于 delta 计算）
  queries_total?: number;
  commits_total?: number;
  rollbacks_total?: number;
}

export interface SlowQuery {
  id: string;
  sql_text: string;
  avg_time_ms: number;
  max_time_ms: number;
  execution_count: number;
  first_seen: string;
  last_seen: string;
}

export interface HealthCheckResult {
  health_score: number;
  status: 'healthy' | 'warning' | 'critical';
  checks: { name: string; status: string; score: number; message?: string }[];
  db_version?: string | null;
  data_size_gb?: number | null;
  dimensions?: Record<string, number>;
}

class DatabaseService {
  private connections: Map<number, DatabaseConnection> = new Map();

  /**
   * 添加数据库连接
   */
  async addConnection(
    id: number,
    name: string,
    config: DatabaseConfig
  ): Promise<boolean> {
    const dbType = config.db_type || 'mysql';

    try {
      if (dbType === 'postgresql') {
        // PostgreSQL 连接
        const pgClient = new PgClient({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database || 'postgres',
          connectionTimeoutMillis: 5000,
        });

        await pgClient.connect();
        await pgClient.query('SELECT 1');

        this.connections.set(id, {
          id,
          name,
          config,
          pool: null,
          pgClient,
          oracleConnection: null,
          dmConnection: null,
          connected: true,
          db_type: 'postgresql',
        });

        console.log(`✅ PostgreSQL 连接成功：${name} (${config.host}:${config.port})`);
        return true;
      } else if (dbType === 'oracle') {
        // Oracle 连接 — 使用连接池 (D-14) + TCPS (D-13)
        // D-19: 检测 oracledb 版本 — Thin mode 支持 12c+, 11g 需要 Thick mode
        if (oracledb.oracleClientVersion === 0 || oracledb.oracleClientVersion == null) {
          // Thin mode (纯 JS), 适用 12c+
          console.log(`[Oracle] Thin mode — 适用于 Oracle 12c+`);
        } else {
          console.log(`[Oracle] Thick mode (oracleClientVersion=${oracledb.oracleClientVersion})`);
        }
        // D-18: NLS_LANG 默认 AMERICAN_AMERICA.AL32UTF8 (oracledb 默认值)

        const pool = await oracledb.createPool({
          user: config.user,
          password: config.password,
          connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${config.host})(PORT=${config.port}))(CONNECT_DATA=(SERVICE_NAME=${config.database || 'ORCL'})))`,
          fetchAsString: [oracledb.NUMBER],
          fetchAsBuffer: [oracledb.CLOB],
          poolMax: 4,
          poolMin: 0,
          poolTimeout: 60,
          queueRequests: true,
          queueMax: 500,
          queueTimeout: 60000,
        });

        // 获取持久连接（保持向后兼容）
        const connection = await pool.getConnection();
        await connection.execute('SELECT 1 FROM DUAL');

        this.connections.set(id, {
          id,
          name,
          config,
          pool: null,
          pgClient: null,
          oracleConnection: connection,
          oraclePool: pool,
          dmConnection: null,
          connected: true,
          db_type: 'oracle',
        });

        console.log(`✅ Oracle 连接成功：${name} (${config.host}:${config.port})`);
        return true;
      } else if (dbType === 'dameng') {
        // 达梦数据库连接 - 使用官方 dmdb 驱动
        // 强制 IPv4：Docker 容器通常只绑定 0.0.0.0，localhost 解析到 ::1 会导致 ETIMEDOUT
        const host = config.host === 'localhost' ? '127.0.0.1' : config.host;
        const dmConnection = await dmdb.getConnection({
          user: config.user,
          password: config.password,
          connectString: `${host}:${config.port}`,
          schema: config.database || undefined,
          connectTimeout: 5000,
          loginEncrypt: false,
        });

        await dmConnection.execute('SELECT 1 FROM DUAL');

        this.connections.set(id, {
          id,
          name,
          config,
          pool: null,
          pgClient: null,
          oracleConnection: null,
          dmConnection,
          connected: true,
          db_type: 'dameng',
        });

        console.log(`✅ 达梦数据库连接成功：${name} (${config.host}:${config.port})`);
        return true;
      } else if (dbType === 'mysql') {
        // MySQL 连接
        const pool = mysql.createPool({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database || 'mysql',
          connectionLimit: 5,
          waitForConnections: true,
          timezone: '+08:00',
          enableKeepAlive: true,
          keepAliveInitialDelay: 10000,
        });

        // 测试连接
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();

        this.connections.set(id, {
          id,
          name,
          config,
          pool,
          pgClient: null,
          oracleConnection: null,
          dmConnection: null,
          connected: true,
          db_type: 'mysql',
        });

        console.log(`✅ MySQL 连接成功：${name} (${config.host}:${config.port})`);
        return true;
      } else {
        console.log(`⚠️ 暂不支持 ${dbType} 数据库的自动连接`);
        return false;
      }
    } catch (error: any) {
      console.error(`❌ ${dbType === 'postgresql' ? 'PostgreSQL' : dbType === 'oracle' ? 'Oracle' : dbType === 'dameng' ? '达梦' : 'MySQL'} 连接失败：${name}`, error);
      return false;
    }
  }

  /**
   * 获取连接
   */
  getConnection(id: number): DatabaseConnection | null {
    return this.connections.get(id) || null;
  }

  /**
   * 删除连接
   */
  async removeConnection(id: number): Promise<void> {
    const conn = this.connections.get(id);
    if (conn?.pool) {
      await conn.pool.end();
    }
    if (conn?.pgClient) {
      await conn.pgClient.end();
    }
    if (conn?.oraclePool) {
      await conn.oraclePool.close(0);
    }
    if (conn?.dmConnection) {
      await conn.dmConnection.close();
    }
    this.connections.delete(id);
  }

  /**
   * 获取实时指标
   */
  async getRealtimeMetrics(id: number): Promise<RealtimeMetrics | null> {
    return this._withAutoReconnect(id, async (conn) => {
      if (conn.db_type === 'postgresql' && conn.pgClient) {
        return this.getPostgreSQLMetrics(conn, id);
      } else if (conn.db_type === 'mysql' && conn.pool) {
        return this.getMySQLMetrics(conn, id);
      } else if (conn.db_type === 'oracle' && conn.oraclePool) {
        return this.getOracleMetrics(conn, id);
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        return this.getDamengMetrics(conn, id);
      }
      return null;
    }, 'getRealtimeMetrics');
  }

  /**
   * 获取 MySQL 实时指标
   */
  private async getMySQLMetrics(conn: DatabaseConnection, id: number): Promise<RealtimeMetrics | null> {
    if (!conn.pool) return null;

    try {
      const [connectionsResult] = await conn.pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) as count FROM information_schema.PROCESSLIST'
      );
      const connections = connectionsResult[0]?.count || 0;

      // 获取最大连接数
      const [maxConnResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW VARIABLES LIKE 'max_connections'"
      );
      const maxConnections = maxConnResult[0]?.Value || 151;

      // 获取累计计数器和 slow_queries（一次查询获取需要的所有变量）
      const [statusResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Queries', 'Com_commit', 'Com_rollback', 'Uptime', 'Slow_queries', 'Bytes_received', 'Bytes_sent', 'Threads_running', 'Threads_connected', 'Threads_created', 'Connections')"
      );
      const queries = Number(statusResult.find((r: any) => r.Variable_name === 'Queries')?.Value) || 0;
      const commits = Number(statusResult.find((r: any) => r.Variable_name === 'Com_commit')?.Value) || 0;
      const rollbacks = Number(statusResult.find((r: any) => r.Variable_name === 'Com_rollback')?.Value) || 0;
      const uptime = Number(statusResult.find((r: any) => r.Variable_name === 'Uptime')?.Value) || 1;
      const slowQueriesRaw = Number(statusResult.find((r: any) => r.Variable_name === 'Slow_queries')?.Value) || 0;
      const bytesReceived = Number(statusResult.find((r: any) => r.Variable_name === 'Bytes_received')?.Value) || 0;
      const bytesSent = Number(statusResult.find((r: any) => r.Variable_name === 'Bytes_sent')?.Value) || 0;
      const threadsRunning = Number(statusResult.find((r: any) => r.Variable_name === 'Threads_running')?.Value) || 0;
      const threadsConnected = Number(statusResult.find((r: any) => r.Variable_name === 'Threads_connected')?.Value) || 0;
      const threadsCreated = Number(statusResult.find((r: any) => r.Variable_name === 'Threads_created')?.Value) || 0;
      const totalConnectionsVal = Number(statusResult.find((r: any) => r.Variable_name === 'Connections')?.Value) || 0;

      // Delta QPS/TPS
      const now = Date.now();
      let qps = 0;
      let tps = 0;
      const isFirstCollection = !conn.deltaCounter;
      if (isFirstCollection) {
        conn.deltaCounter = { queries, commits, rollbacks, bytesReceived, bytesSent, slowQueries: slowQueriesRaw, timestamp: now, abortedConnects: 0, handlerReadRndNext: 0 };
      } else {
        const elapsedSeconds = (now - conn.deltaCounter.timestamp) / 1000;
        if (elapsedSeconds > 0) {
          qps = Math.round((queries - conn.deltaCounter.queries) / elapsedSeconds);
          tps = Math.round(((commits + rollbacks) - (conn.deltaCounter.commits + conn.deltaCounter.rollbacks)) / elapsedSeconds);
        }
        conn.deltaCounter.queries = queries;
        conn.deltaCounter.commits = commits;
        conn.deltaCounter.rollbacks = rollbacks;
        conn.deltaCounter.bytesReceived = bytesReceived;
        conn.deltaCounter.bytesSent = bytesSent;
        conn.deltaCounter.slowQueries = slowQueriesRaw;
        conn.deltaCounter.timestamp = now;
      }

      // 获取版本
      const [versionResult] = await conn.pool.query<RowDataPacket[]>(
        "SELECT VERSION() as version"
      );
      const version = versionResult[0]?.version || '';

      // CPU 使用率 — 加权复合估算（thread ratio + buffer pool + base）
      const cpuUsage = Math.min(100, Math.round(
        (threadsRunning / Math.max(1, maxConnections)) * 60 +
        (20) // base load
      ));

      // InnoDB 缓冲池命中率 + memory/disk 估算
      const [poolPagesResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_pages_total', 'Innodb_buffer_pool_pages_free', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')"
      );
      const totalPoolPages = Number(poolPagesResult.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_pages_total')?.Value) || 1000;
      const freePoolPages = Number(poolPagesResult.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_pages_free')?.Value) || 200;
      const memoryUsage = Math.round(((totalPoolPages - freePoolPages) / totalPoolPages) * 100);

      const poolReadRequests = Number(poolPagesResult.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_read_requests')?.Value) || 0;
      const poolReads = Number(poolPagesResult.find((r: any) => r.Variable_name === 'Innodb_buffer_pool_reads')?.Value) || 0;
      const innodbBufferPoolHitRate = poolReadRequests > 0
        ? ((poolReadRequests - poolReads) / poolReadRequests * 100)
        : 100;

      // 磁盘大小 — 从 information_schema.tables 计算
      const [diskResult] = await conn.pool.query<RowDataPacket[]>(
        "SELECT COALESCE(SUM(data_length + index_length), 0) as total_bytes FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')"
      );
      const dataSizeGb = Math.round((Number(diskResult[0]?.total_bytes) || 0) / (1024 * 1024 * 1024) * 100) / 100;
      const diskUsage = Math.min(95, Math.round(dataSizeGb / 10 * 100)); // rough: 10GB ≈ 100%

      // 行锁等待
      const [rowLockResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name = 'Innodb_row_lock_time_avg'"
      );
      const innodbRowLockTimeAvg = Number(rowLockResult[0]?.Value) || 0;

      // 死锁
      const [deadlockResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name = 'Innodb_deadlocks'"
      );
      const innodbDeadlocks = Number(deadlockResult[0]?.Value) || 0;

      // 磁盘临时表
      const [tmpTableResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Created_tmp_disk_tables', 'Created_tmp_tables')"
      );
      const tmpDiskTables = Number(tmpTableResult.find((r: any) => r.Variable_name === 'Created_tmp_disk_tables')?.Value) || 0;

      // 线程缓存命中率（复用已查询的 threadsCreated, totalConnectionsVal）
      const threadCacheHitRate = totalConnectionsVal > 0
        ? ((totalConnectionsVal - threadsCreated) / totalConnectionsVal * 100)
        : 100;

      // MySQL 扩增指标
      // table_open_cache_hit_rate
      const [tableCacheResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Table_open_cache_hits', 'Table_open_cache_misses', 'Table_open_cache_overflows')"
      );
      const tableOpenCacheHits = Number(tableCacheResult.find((r: any) => r.Variable_name === 'Table_open_cache_hits')?.Value) || 0;
      const tableOpenCacheMisses = Number(tableCacheResult.find((r: any) => r.Variable_name === 'Table_open_cache_misses')?.Value) || 0;
      const tableOpenCacheHitRate = (tableOpenCacheHits + tableOpenCacheMisses) > 0
        ? Math.round(tableOpenCacheHits / (tableOpenCacheHits + tableOpenCacheMisses) * 10000) / 100
        : 100;

      // handler_read_rnd_next (全表扫累计值)
      const [handlerResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name = 'Handler_read_rnd_next'"
      );
      const handlerReadRndNext = Number(handlerResult[0]?.Value) || 0;
      // handler_read_rnd_next_rate via delta (skip first collection)
      let handlerReadRndNextRate = 0;
      if (!isFirstCollection && conn.deltaCounter) {
        const elapsed = (now - conn.deltaCounter.timestamp) / 1000;
        if (elapsed > 0 && handlerReadRndNext >= conn.deltaCounter.handlerReadRndNext) {
          handlerReadRndNextRate = Math.round((handlerReadRndNext - conn.deltaCounter.handlerReadRndNext) / elapsed * 100) / 100;
        }
      }
      if (conn.deltaCounter) conn.deltaCounter.handlerReadRndNext = handlerReadRndNext;

      // key_blocks_usage
      const [keyBlockResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Key_blocks_used', 'Key_blocks_unused')"
      );
      const keyBlocksUsed = Number(keyBlockResult.find((r: any) => r.Variable_name === 'Key_blocks_used')?.Value) || 0;
      const keyBlocksUnused = Number(keyBlockResult.find((r: any) => r.Variable_name === 'Key_blocks_unused')?.Value) || 0;
      const keyBlocksUsage = (keyBlocksUsed + keyBlocksUnused) > 0
        ? Math.round(keyBlocksUsed / (keyBlocksUsed + keyBlocksUnused) * 10000) / 100
        : 0;

      // open_files
      const [openFilesResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name = 'Open_files'"
      );
      const openFiles = Number(openFilesResult[0]?.Value) || 0;

      // aborted_connects
      const [abortedResult] = await conn.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL STATUS WHERE Variable_name = 'Aborted_connects'"
      );
      const abortedConnects = Number(abortedResult[0]?.Value) || 0;
      // aborted_connects_rate via delta (skip first collection)
      let abortedConnectsRate = 0;
      if (!isFirstCollection && conn.deltaCounter) {
        const elapsed = (now - conn.deltaCounter.timestamp) / 1000;
        if (elapsed > 0 && abortedConnects >= conn.deltaCounter.abortedConnects) {
          abortedConnectsRate = Math.round((abortedConnects - conn.deltaCounter.abortedConnects) / elapsed * 100) / 100;
        }
        conn.deltaCounter.abortedConnects = abortedConnects;
      } else if (conn.deltaCounter) {
        conn.deltaCounter.abortedConnects = abortedConnects;
      }

      // 复制状态
      let replicationLag: number | undefined;
      let replicationStatus: 'running' | 'stopped' | 'error' | undefined;
      try {
        const [slaveStatus] = await conn.pool.query<RowDataPacket[]>('SHOW SLAVE STATUS');
        if (slaveStatus && slaveStatus.length > 0) {
          const slave = slaveStatus[0];
          replicationLag = slave.Seconds_Behind_Master || 0;
          replicationStatus = slave.Slave_SQL_Running === 'Yes' && slave.Slave_IO_Running === 'Yes'
            ? 'running'
            : slave.Slave_SQL_Running === 'No' || slave.Slave_IO_Running === 'No'
              ? 'stopped'
              : 'error';
        }
      } catch (e) {
        // 没有配置主从复制
      }

      // InnoDB 8.0+ 兼容：Innodb_active_transactions 可能为 NULL，用 INNODB_TRX 表
      let activeTransactions = 0;
      try {
        const [innodbTrxResult] = await conn.pool.query<RowDataPacket[]>(
          "SELECT COUNT(*) as count FROM information_schema.INNODB_TRX"
        );
        activeTransactions = Number(innodbTrxResult[0]?.count) || 0;
      } catch {
        activeTransactions = 0;
      }

      return {
        cpu_usage: cpuUsage,
        memory_usage: memoryUsage,
        disk_usage: diskUsage,
        connections,
        max_connections: maxConnections,
        qps,
        tps,
        active_transactions: activeTransactions,
        slow_queries: slowQueriesRaw,
        db_type: 'mysql',
        innodb_buffer_pool_hit_rate: Math.round(innodbBufferPoolHitRate * 100) / 100,
        buffer_pool_hit_rate: Math.round(innodbBufferPoolHitRate * 100) / 100, // C2: recordMetrics expects this field name
        innodb_row_lock_time_avg: Math.round(innodbRowLockTimeAvg * 100) / 100,
        innodb_deadlocks: innodbDeadlocks,
        tmp_table_on_disk: tmpDiskTables,
        thread_cache_hit_rate: Math.round(threadCacheHitRate * 100) / 100,
        replication_lag: replicationLag,
        replication_status: replicationStatus,
        uptime_seconds: uptime,
        version,
        table_open_cache_hit_rate: tableOpenCacheHitRate,
        handler_read_rnd_next: handlerReadRndNext,
        handler_read_rnd_next_rate: handlerReadRndNextRate,
        key_blocks_usage: keyBlocksUsage,
        open_files: openFiles,
        aborted_connects: abortedConnects,
        aborted_connects_rate: Math.round(abortedConnectsRate * 100) / 100,
        bytes_received: bytesReceived,
        bytes_sent: bytesSent,
        queries_total: queries,
        commits_total: commits,
        rollbacks_total: rollbacks,
        threads_running: threadsRunning,
        threads_connected: threadsConnected,
        data_size_gb: dataSizeGb,
        is_estimated: true,
      };
    } catch (error) {
      console.error(`获取 MySQL 实时指标失败：${id}`, error);
      return null;
    }
  }

  /**
   * 获取 PostgreSQL 实时指标
   */
  private async getPostgreSQLMetrics(conn: DatabaseConnection, id: number): Promise<RealtimeMetrics | null> {
    if (!conn.pgClient) return null;

    try {
      // 获取连接数
      const connResult = await conn.pgClient.query<{ count: string }>(
        'SELECT COUNT(*) FROM pg_stat_activity'
      );
      const connections = parseInt(connResult.rows[0]?.count || '0');

      // 获取版本
      const verResult = await conn.pgClient.query('SELECT version()');
      const version = verResult.rows[0]?.version || '';

      // 获取最大连接数
      const maxConnResult = await conn.pgClient.query<{ setting: string }>(
        "SHOW max_connections"
      );
      const maxConnections = parseInt(maxConnResult.rows[0]?.setting || '100');

      // 检测 pg_stat_database 实际可用列（跨版本兼容）
      const colCheck = await conn.pgClient.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'pg_catalog' AND table_name = 'pg_stat_database'
      `);
      const availableCols = new Set(colCheck.rows.map((r: any) => r.column_name));

      // 根据实际可用列动态构建查询
      const hasBlksRead = availableCols.has('blks_read');
      const hasBlkRead = availableCols.has('blk_read');
      const hasLockWait = availableCols.has('lock_wait_count');
      const hasTempFiles = availableCols.has('temp_files');
      const hasDeadlocks = availableCols.has('deadlocks');

      const readCol = hasBlksRead ? 'blks_read' : (hasBlkRead ? 'blk_read' : null);
      const hitCol = hasBlksRead ? 'blks_hit' : (hasBlkRead ? 'blk_hit' : null);

      const selectParts = [
        'SUM(xact_commit) as xact_commit',
        'SUM(xact_rollback) as xact_rollback',
        'SUM(tup_returned) as tup_returned',
        'SUM(tup_fetched) as tup_fetched',
        'SUM(tup_inserted) as tup_inserted',
        'SUM(tup_updated) as tup_updated',
        'SUM(tup_deleted) as tup_deleted',
      ];
      if (readCol) selectParts.push(`SUM(${readCol}) as blk_read`);
      else selectParts.push('0 as blk_read');
      if (hitCol) selectParts.push(`SUM(${hitCol}) as blk_hit`);
      else selectParts.push('0 as blk_hit');
      if (hasTempFiles) selectParts.push('SUM(temp_files) as temp_files');
      else selectParts.push('0 as temp_files');
      if (hasDeadlocks) selectParts.push('SUM(deadlocks) as deadlocks');
      else selectParts.push('0 as deadlocks');
      if (hasLockWait) selectParts.push('SUM(lock_wait_count) as lock_wait_count');
      else selectParts.push('0 as lock_wait_count');

      const dbStatsResult = await conn.pgClient.query(`
        SELECT ${selectParts.join(', ')}
        FROM pg_stat_database
        WHERE datname = current_database()
      `);

      const stats = dbStatsResult.rows[0] || {};
      const xactCommit = parseInt(stats.xact_commit || '0');
      const xactRollback = parseInt(stats.xact_rollback || '0');
      const tupReturned = parseInt(stats.tup_returned || '0');
      const tupFetched = parseInt(stats.tup_fetched || '0');
      const tupInserted = parseInt(stats.tup_inserted || '0');
      const tupUpdated = parseInt(stats.tup_updated || '0');
      const tupDeleted = parseInt(stats.tup_deleted || '0');
      const blkRead = parseInt(stats.blk_read || '0');
      const blkHit = parseInt(stats.blk_hit || '0');
      const tempFiles = parseInt(stats.temp_files || '0');
      const deadlocks = parseInt(stats.deadlocks || '0');
      const lockWaitCount = parseInt(stats.lock_wait_count || '0');

      // 缓存命中率
      const totalBlk = blkRead + blkHit;
      const cacheHitRate = totalBlk > 0 ? (blkHit / totalBlk * 100) : 100;

      // 获取 CPU 使用率 - 活动会话 / 最大连接数
      const cpuResult = await conn.pgClient.query(`
        SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE state = 'active') as active
        FROM pg_stat_activity WHERE state IS NOT NULL
      `);
      const totalSessions = parseInt(cpuResult.rows[0]?.total || '0');
      const activeSessions = parseInt(cpuResult.rows[0]?.active || '0');
      const cpuUsage = maxConnections > 0
        ? Math.min(100, Math.round((activeSessions / maxConnections) * 100))
        : 0;

      // 内存使用率
      const memoryUsage = Math.min(100, Math.round((activeSessions / Math.max(1, totalSessions)) * 50 + 20));

      // 活动事务数
      const xactResult = await conn.pgClient.query(`
        SELECT COUNT(*) as active_xacts FROM pg_stat_activity WHERE xact_start IS NOT NULL
      `);
      const activeTransactions = parseInt(xactResult.rows[0]?.active_xacts || '0');

      // Delta QPS/TPS (PG)
      const now = Date.now();
      let qps = 0;
      let tps = 0;
      if (!conn.pgDeltaCounter) {
        conn.pgDeltaCounter = { xactCommit, xactRollback, blksRead: blkRead, blksHit: blkHit, timestamp: now };
      } else {
        const elapsed = (now - conn.pgDeltaCounter.timestamp) / 1000;
        if (elapsed > 0) {
          qps = Math.round((xactCommit - conn.pgDeltaCounter.xactCommit) / elapsed);
          tps = Math.round(((xactCommit + xactRollback) - (conn.pgDeltaCounter.xactCommit + conn.pgDeltaCounter.xactRollback)) / elapsed);
        }
        conn.pgDeltaCounter = { xactCommit, xactRollback, blksRead: blkRead, blksHit: blkHit, timestamp: now };
      }

      // 磁盘大小
      const diskResult = await conn.pgClient.query(
        "SELECT pg_database_size(current_database()) as size_bytes"
      );
      const dataSizeGb = Math.round(Number(diskResult.rows[0]?.size_bytes || 0) / (1024*1024*1024) * 100) / 100;
      const diskUsage = Math.min(95, Math.round(dataSizeGb / 10 * 100));

      // PG 扩增: idx_scan_ratio
      const idxScanResult = await conn.pgClient.query(
        "SELECT COALESCE(SUM(idx_scan), 0) as idx, COALESCE(SUM(seq_scan), 0) as seq FROM pg_stat_user_tables"
      );
      const idxScans = parseInt(idxScanResult.rows[0]?.idx || '0');
      const seqScans = parseInt(idxScanResult.rows[0]?.seq || '0');
      const idxScanRatio = (idxScans + seqScans) > 0
        ? Math.round(idxScans / (idxScans + seqScans) * 10000) / 100
        : 100;

      // PG 扩增: dead_tuples
      const deadTupleResult = await conn.pgClient.query(
        "SELECT COALESCE(SUM(n_dead_tup), 0) as dead FROM pg_stat_user_tables"
      );
      const deadTuples = parseInt(deadTupleResult.rows[0]?.dead || '0');

      // PG 扩增: vacuum counts (count tables with recent vacuum)
      let vacuumCount = 0;
      let autovacuumCount = 0;
      try {
        const vacuumResult = await conn.pgClient.query(
          "SELECT COUNT(*) FILTER (WHERE last_vacuum IS NOT NULL) as vacuum_count, COUNT(*) FILTER (WHERE last_autovacuum IS NOT NULL) as autovacuum_count FROM pg_stat_user_tables"
        );
        vacuumCount = parseInt(vacuumResult.rows[0]?.vacuum_count || '0');
        autovacuumCount = parseInt(vacuumResult.rows[0]?.autovacuum_count || '0');
      } catch { /* vacuum stats unavailable */ }

      // PG 扩增: replication lag
      let replicationLagSeconds = 0;
      try {
        const replResult = await conn.pgClient.query(
          "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0) as lag_seconds"
        );
        replicationLagSeconds = Math.round(Number(replResult.rows[0]?.lag_seconds || 0) * 100) / 100;
      } catch { /* replication not configured or permission denied */ }

      // PG 扩增: cache_hit_ratio (复用已有的 cacheHitRate)
      const cacheHitRatio = Math.round(cacheHitRate * 100) / 100;

      return {
        cpu_usage: cpuUsage,
        memory_usage: memoryUsage,
        disk_usage: diskUsage,
        connections,
        max_connections: maxConnections,
        qps,
        tps,
        active_transactions: activeTransactions,
        slow_queries: 0,
        db_type: 'postgresql',
        cache_hit_rate: cacheHitRatio,
        cache_hit_ratio: cacheHitRatio,
        idx_scan_ratio: idxScanRatio,
        dead_tuples: deadTuples,
        connections_used: connections,
        connections_max: maxConnections,
        vacuum_count: vacuumCount,
        autovacuum_count: autovacuumCount,
        replication_lag_seconds: replicationLagSeconds,
        xact_commit: xactCommit,
        xact_rollback: xactRollback,
        tup_returned: tupReturned,
        tup_fetched: tupFetched,
        tup_inserted: tupInserted,
        tup_updated: tupUpdated,
        tup_deleted: tupDeleted,
        blk_read: blkRead,
        blk_hit: blkHit,
        temp_files: tempFiles,
        deadlock_count: deadlocks,
        lock_wait_count: lockWaitCount,
        data_size_gb: dataSizeGb,
        version,
        is_estimated: true,
      };
    } catch (error) {
      console.error(`获取 PostgreSQL 实时指标失败：${id}`, error);
      return null;
    }
  }

  /**
   * 获取 Oracle 实时指标
   */
  private async getOracleMetrics(conn: DatabaseConnection, id: number): Promise<RealtimeMetrics | null> {
    if (!conn.oracleConnection) return null;

    try {
      // 获取连接数
      const connResult = await conn.oracleConnection.execute(
        'SELECT COUNT(*) as count FROM V$SESSION'
      );
      const connections = connResult.rows[0]?.[0] as number || 0;

      // 获取最大连接数
      const maxConnResult = await conn.oracleConnection.execute(
        "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'processes'"
      );
      const maxConnections = maxConnResult.rows[0]?.[0] as number || 300;

      // 获取活动会话数
      const activeResult = await conn.oracleConnection.execute(
        'SELECT COUNT(*) as count FROM V$SESSION WHERE STATUS = \'ACTIVE\''
      );
      const activeSessions = activeResult.rows[0]?.[0] as number || 0;

      // 获取系统统计
      const statResult = await conn.oracleConnection.execute(`
        SELECT
          SUM(CASE WHEN NAME = 'parse count (hard)' THEN VALUE ELSE 0 END) as hard_parses,
          SUM(CASE WHEN NAME = 'parse count (total)' THEN VALUE ELSE 0 END) as total_parses,
          SUM(CASE WHEN NAME = 'execute count' THEN VALUE ELSE 0 END) as executes,
          SUM(CASE WHEN NAME = 'user commits' THEN VALUE ELSE 0 END) as commits
        FROM V$SYSSTAT
        WHERE NAME IN ('parse count (hard)', 'parse count (total)', 'execute count', 'user commits')
      `);

      const stats = statResult.rows[0] || {};
      const hardParses = stats.hard_parses as number || 0;
      const totalParses = stats.total_parses as number || 0;
      const executes = stats.executes as number || 0;
      const commits = stats.commits as number || 0;

      // Delta-based QPS/TPS 计算 (Bug 2 修复 — 替代硬编码比值)
      const now = Date.now();
      let qps = Math.floor(executes / 100);  // 临时回退
      let tps = Math.floor(commits / 10);     // 临时回退
      if (conn.oracleDeltaCounter) {
        const elapsedSeconds = (now - conn.oracleDeltaCounter.timestamp) / 1000;
        if (elapsedSeconds > 0) {
          const execDelta = executes - conn.oracleDeltaCounter.executes;
          const commitDelta = commits - conn.oracleDeltaCounter.commits;
          qps = Math.max(0, Math.round(execDelta / elapsedSeconds));
          tps = Math.max(0, Math.round(commitDelta / elapsedSeconds));
        }
      }
      conn.oracleDeltaCounter = { executes, commits, timestamp: now };

      // 缓存命中率 (Library Cache Hit Ratio)
      const libraryCacheResult = await conn.oracleConnection.execute(`
        SELECT ROUND(SUM(pinhits) / SUM(pins) * 100, 2) as hit_rate
        FROM V$LIBRARYCACHE
      `);
      const libraryCacheHitRate = libraryCacheResult.rows[0]?.[0] as number || 100;

      // PGA 缓存命中率
      const pgaResult = await conn.oracleConnection.execute(`
        SELECT ROUND((1 - (SELECT SUM(value) FROM V$SYSSTAT WHERE name = 'physical reads') /
          ((SELECT SUM(value) FROM V$SYSSTAT WHERE name = 'session pga memory') +
          (SELECT SUM(value) FROM V$SYSSTAT WHERE name = 'physical reads'))) * 100, 2) as hit_rate
        FROM DUAL
      `);
      const pgaCacheHitRate = pgaResult.rows[0]?.[0] as number || 100;

      // 缓冲区命中率 (Buffer Cache Hit Ratio via V$SYSSTAT)
      let sharedPoolHitRate = 100;
      try {
        const bufResult = await conn.oracleConnection.execute(`
          SELECT ROUND((1 - (SUM(DECODE(NAME, 'physical reads', VALUE, 0)) /
            NULLIF(SUM(DECODE(NAME, 'db block gets', VALUE, 0)) + SUM(DECODE(NAME, 'consistent gets', VALUE, 0)), 0))) * 100, 2)
          FROM V$SYSSTAT
        `);
        sharedPoolHitRate = bufResult.rows[0]?.[0] as number || 100;
      } catch {
        console.warn(`[OracleMetrics] V$SYSSTAT 缓冲区命中率查询失败`);
      }

      // 表空间使用率 (Pitfall 3: DBA 权限不足时降级)
      let tablespaceUsagePercent = null;
      try {
        const tablespaceResult = await conn.oracleConnection.execute(`
          SELECT MAX(usage_percent) FROM (
            SELECT ROUND((1 - NVL(fs.free_bytes, 0) / NULLIF(SUM(df.bytes), 0)) * 100, 2) as usage_percent
            FROM DBA_DATA_FILES df
            LEFT JOIN (
              SELECT tablespace_name, SUM(bytes) as free_bytes
              FROM DBA_FREE_SPACE GROUP BY tablespace_name
            ) fs ON fs.tablespace_name = df.tablespace_name
            WHERE df.tablespace_name NOT IN ('SYSTEM', 'SYSAUX')
            GROUP BY df.tablespace_name, fs.free_bytes
          )
        `);
        tablespaceUsagePercent = tablespaceResult.rows[0]?.[0] as number ?? null;
      } catch {
        console.warn(`[OracleMetrics] DBA 视图权限不足，表空间使用率不可用 (instance ${id})`);
        tablespaceUsagePercent = null;
      }

      // 死锁数量
      const deadlockResult = await conn.oracleConnection.execute(
        "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
      );
      const enqueueDeadlocks = deadlockResult.rows[0]?.[0] as number || 0;

      // 获取 CPU 使用率 - 从活动会话比例计算
      const cpuUsage = maxConnections > 0
        ? Math.min(100, Math.round((activeSessions / maxConnections) * 100))
        : 0;

      // 获取内存使用率 - 从 PGA 和 SGA 使用率估算
      const memoryUsage = Math.min(100, Math.round((100 - pgaCacheHitRate) * 0.5 + (tablespaceUsagePercent || 50) * 0.5));

      // 获取版本号
      let version = '';
      try {
        const versionResult = await conn.oracleConnection.execute(
          "SELECT VERSION FROM V$INSTANCE"
        );
        version = versionResult.rows[0]?.[0] as string || '';
      } catch { /* V$INSTANCE 不可用时降级 */ }

      // SGA 大小 (D-08 实例详情展示)
      let sgaSizeMb = 0;
      try {
        const sgaResult = await conn.oracleConnection.execute(
          'SELECT ROUND(SUM(bytes)/1024/1024, 2) FROM V$SGA'
        );
        sgaSizeMb = sgaResult.rows[0]?.[0] as number || 0;
      } catch {
        sgaSizeMb = 0;
      }

      // PGA 大小 (D-08 实例详情展示)
      let pgaSizeMb = 0;
      try {
        const pgaResult = await conn.oracleConnection.execute(
          "SELECT ROUND(value/1024/1024, 2) FROM V$PGASTAT WHERE NAME = 'total PGA allocated'"
        );
        pgaSizeMb = pgaResult.rows[0]?.[0] as number || 0;
      } catch {
        pgaSizeMb = 0;
      }

      return {
        cpu_usage: cpuUsage,
        memory_usage: memoryUsage,
        disk_usage: tablespaceUsagePercent || 0,
        connections,
        max_connections: maxConnections,
        qps,
        tps,
        active_transactions: activeSessions,
        slow_queries: 0,
        db_type: 'oracle',
        pga_cache_hit_rate: Math.round(pgaCacheHitRate * 100) / 100,
        library_cache_hit_rate: Math.round(libraryCacheHitRate * 100) / 100,
        shared_pool_hit_rate: Math.round(sharedPoolHitRate * 100) / 100,
        enqueue_deadlocks: enqueueDeadlocks,
        tablespace_usage_percent: tablespaceUsagePercent !== null ? Math.round(tablespaceUsagePercent * 100) / 100 : null,
        active_sessions: activeSessions,
        sga_size_mb: Math.round(sgaSizeMb * 100) / 100,
        pga_size_mb: Math.round(pgaSizeMb * 100) / 100,
        version,
      };
    } catch (error) {
      console.error(`获取 Oracle 实时指标失败：${id}`, error);
      return null;
    }
  }

  /**
   * 获取达梦 (Dameng) 实时指标
   */
  private async getDamengMetrics(conn: DatabaseConnection, id: number): Promise<RealtimeMetrics | null> {
    if (!conn.dmConnection) return null;

    try {
      // 获取连接数 - 达梦使用 V$SESSIONS
      const connResult = await conn.dmConnection.execute(
        'SELECT COUNT(*) as count FROM V$SESSIONS'
      );
      const connections = connResult.rows[0]?.[0] as number || 0;

      // 获取最大连接数
      const maxConnResult = await conn.dmConnection.execute(
        "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'"
      );
      const maxConnections = maxConnResult.rows[0]?.[0] as number || 500;

      // 获取活动会话数
      const activeResult = await conn.dmConnection.execute(
        "SELECT COUNT(*) as count FROM V$SESSIONS WHERE STATE = 'ACTIVE'"
      );
      const activeSessions = activeResult.rows[0]?.[0] as number || 0;

      // 获取系统统计
      const statResult = await conn.dmConnection.execute(`
        SELECT
          SUM(CASE WHEN NAME = 'parse count' THEN STAT_VAL ELSE 0 END) as parses,
          SUM(CASE WHEN NAME = 'sql executed count' THEN STAT_VAL ELSE 0 END) as executes,
          SUM(CASE WHEN NAME = 'transaction commit count' THEN STAT_VAL ELSE 0 END) as commits
        FROM V$SYSSTAT
        WHERE NAME IN ('parse count', 'sql executed count', 'transaction commit count')
      `);

      const stats = statResult.rows[0] || {};
      const parses = stats.parses as number || 0;
      const executes = stats.executes as number || 0;
      const commits = stats.commits as number || 0;

      // 缓冲池命中率 - Dameng uses V$BUFFERPOOL with RAT_HIT column
      const bufferResult = await conn.dmConnection.execute(`
        SELECT NVL(RAT_HIT, 0) * 100 as hit_rate
        FROM V$BUFFERPOOL
        WHERE ID = 0
      `);
      const dmBufferHitRate = bufferResult.rows[0]?.[0] as number || 100;

      // 锁等待数量
      let dmLockWait = 0;
      try {
        const lockWaitResult = await conn.dmConnection.execute(
          "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
        );
        dmLockWait = lockWaitResult.rows[0]?.[0] as number || 0;
      } catch {
        // V$LOCK.BLOCK 在某些达梦版本中不存在，回退到全表计数
        try {
          const lockResult = await conn.dmConnection.execute(
            "SELECT COUNT(*) as count FROM V$LOCK"
          );
          dmLockWait = lockResult.rows[0]?.[0] as number || 0;
        } catch {
          dmLockWait = 0;
        }
      }

      // 死锁数量
      const deadlockResult = await conn.dmConnection.execute(
        "SELECT COUNT(*) as count FROM V$DEADLOCK_HISTORY"
      );
      const dmDeadlockCount = deadlockResult.rows[0]?.[0] as number || 0;

      // 内存使用 - 从 V$SYSSTAT 获取 (V$MEMORY_INFO 不存在于 Dameng)
      let dmPagedMemoryUsage = 0;
      let dmOsMemoryUsage = 0;
      try {
        const memTotalResult = await conn.dmConnection.execute(
          "SELECT STAT_VAL FROM V$SYSSTAT WHERE NAME = 'memory pool size in bytes'"
        );
        const memUsedResult = await conn.dmConnection.execute(
          "SELECT STAT_VAL FROM V$SYSSTAT WHERE NAME = 'memory used bytes from os'"
        );
        dmPagedMemoryUsage = Number(memTotalResult.rows[0]?.[0]) || 0;
        dmOsMemoryUsage = Number(memUsedResult.rows[0]?.[0]) || 0;
      } catch {
        // 查询失败使用默认值 0
      }

      // 获取 CPU 使用率 - 从活动会话比例计算
      const cpuUsage = maxConnections > 0
        ? Math.min(100, Math.round((activeSessions / maxConnections) * 100))
        : 0;

      // 获取内存使用率 - 从缓冲区命中率估算
      const memoryUsage = Math.min(100, Math.round((100 - dmBufferHitRate) * 0.5 + 30));

      // 获取版本
      const versionResult = await conn.dmConnection.execute(
        "SELECT TRIM(REPLACE(SVR_VERSION, 'DM Database Server x64 ', '')) FROM V$INSTANCE"
      );
      const version = versionResult.rows[0]?.[0] as string || '';

      return {
        cpu_usage: cpuUsage,
        memory_usage: memoryUsage,
        disk_usage: 45,
        connections,
        max_connections: maxConnections,
        qps: Math.floor(executes / 100),
        tps: Math.floor(commits / 10),
        active_transactions: activeSessions,
        slow_queries: 0,
        db_type: 'dameng',
        dm_buffer_hit_rate: Math.round(dmBufferHitRate * 100) / 100,
        dm_lock_wait: dmLockWait,
        dm_deadlock_count: dmDeadlockCount,
        dm_paged_memory_usage: dmPagedMemoryUsage,
        dm_os_memory_usage: dmOsMemoryUsage,
      };
    } catch (error) {
      console.error(`获取达梦实时指标失败：${id}`, error);
      return null;
    }
  }

  /**
   * 获取慢查询列表
   */
  async getSlowQueries(id: number, limit: number = 10): Promise<SlowQuery[] | null> {
    return this._withAutoReconnect(id, async (conn) => {
      if (conn.db_type === 'postgresql' && conn.pgClient) {
        return this.getPostgreSQLSlowQueries(conn, limit);
      } else if (conn.db_type === 'mysql' && conn.pool) {
        return this.getMySQLSlowQueries(conn, limit);
      } else if (conn.db_type === 'oracle' && conn.oraclePool) {
        return this.getOracleSlowQueries(conn, limit);
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        return this.getDamengSlowQueries(conn, limit);
      }
      return null;
    }, 'getSlowQueries');
  }

  /**
   * 获取 MySQL 慢查询
   */
  private async getMySQLSlowQueries(conn: DatabaseConnection, limit: number): Promise<SlowQuery[] | null> {
    if (!conn.pool) return null;

    try {
      // 从 performance_schema 获取慢查询
      const [result] = await conn.pool.query<RowDataPacket[]>(`
        SELECT
          DIGEST_TEXT as sql_text,
          AVG_TIMER_WAIT / 1000000000 as avg_time_ms,
          MAX_TIMER_WAIT / 1000000000 as max_time_ms,
          COUNT_STAR as execution_count,
          FIRST_SEEN,
          LAST_SEEN
        FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST_TEXT IS NOT NULL
          AND AVG_TIMER_WAIT > 1000000000000  -- 平均执行时间 > 1 秒
        ORDER BY AVG_TIMER_WAIT DESC
        LIMIT ?
      `, [limit]);

      return result.map((row: any) => ({
        id: `sq-${row.sql_text.substring(0, 10)}`,
        sql_text: row.sql_text,
        avg_time_ms: row.avg_time_ms,
        max_time_ms: row.max_time_ms,
        execution_count: row.execution_count,
        first_seen: row.FIRST_SEEN,
        last_seen: row.LAST_SEEN,
      }));
    } catch (error) {
      console.error(`获取 MySQL 慢查询失败：${conn.id}`, error);
      // 如果 performance_schema 不可用，尝试从 slow_log 表
      try {
        const [result] = await conn.pool.query<RowDataPacket[]>(
          'SELECT * FROM mysql.slow_log ORDER BY start_time DESC LIMIT ?',
          [limit]
        );
        return result.map((row: any) => ({
          id: `sq-${row.sql_text?.substring(0, 10) || 'unknown'}`,
          sql_text: row.sql_text || '',
          avg_time_ms: row.query_time || 0,
          max_time_ms: row.query_time || 0,
          execution_count: 1,
          first_seen: row.start_time,
          last_seen: row.start_time,
        }));
      } catch (e) {
        return [];
      }
    }
  }

  /**
   * 获取 PostgreSQL 慢查询
   */
  private async getPostgreSQLSlowQueries(conn: DatabaseConnection, limit: number): Promise<SlowQuery[] | null> {
    if (!conn.pgClient) return null;

    try {
      // 首先检查是否安装了 pg_stat_statements 扩展
      const extResult = await conn.pgClient.query(`
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      `);

      if (extResult.rows.length === 0) {
        console.warn(`⚠️  实例 ${conn.id} 未安装 pg_stat_statements 扩展，无法获取慢查询`);
        return [];
      }

      // 检测可用列
      const colCheck = await conn.pgClient.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pg_stat_statements'
      `);
      const availCols = new Set(colCheck.rows.map((r: any) => r.column_name.toLowerCase()));

      // 新版 pg_stat_statements 用 total_exec_time，旧版用 total_time
      const timeCol = availCols.has('total_exec_time') ? 'total_exec_time' : (availCols.has('total_time') ? 'total_time' : null);
      const maxTimeCol = availCols.has('max_exec_time') ? 'max_exec_time' : (availCols.has('max_time') ? 'max_time' : null);
      const minTimeCol = availCols.has('min_exec_time') ? 'min_exec_time' : (availCols.has('min_time') ? 'min_time' : null);
      const hasCalls = availCols.has('calls');
      const hasQueryid = availCols.has('queryid');
      const hasRowsExamined = availCols.has('shared_blks_hit');

      if (!timeCol) {
        console.warn(`⚠️  pg_stat_statements 缺少时间列，无法获取慢查询`);
        return [];
      }

      const result = await conn.pgClient.query(`
        SELECT
          ${hasQueryid ? 'queryid::text as queryid' : "NULL as queryid"},
          query as sql_text,
          ${timeCol} / NULLIF(${hasCalls ? 'calls' : '1'}, 0) as avg_time_ms,
          ${maxTimeCol || timeCol} as max_time_ms,
          ${hasCalls ? 'calls as execution_count' : '1 as execution_count'},
          ${minTimeCol || 'NULL'} as min_time_ms,
          ${hasRowsExamined ? 'shared_blks_hit as rows_examined' : 'NULL as rows_examined'},
          ${availCols.has('rows') ? 'rows as rows_sent' : 'NULL as rows_sent'},
          ${availCols.has('shared_blks_read') ? 'shared_blks_read as blocks_read' : 'NULL as blocks_read'}
        FROM pg_stat_statements
        WHERE ${timeCol} > 1000
        ORDER BY ${timeCol} DESC
        LIMIT $1
      `, [limit]);

      return result.rows.map((row: any) => ({
        id: `sq-${row.queryid || 'unknown'}`,
        sql_text: row.sql_text,
        avg_time_ms: Math.round(row.avg_time_ms || 0),
        max_time_ms: Math.round(row.max_time_ms || 0),
        execution_count: row.execution_count || 1,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        rows_examined: row.rows_examined || 0,
        rows_sent: row.rows_sent || 0,
      }));
    } catch (error) {
      console.error(`获取 PostgreSQL 慢查询失败：${conn.id}`, error);
      return [];
    }
  }

  /**
   * 获取 Oracle 慢查询
   */
  private async getOracleSlowQueries(conn: DatabaseConnection, limit: number): Promise<SlowQuery[] | null> {
    if (!conn.oracleConnection) return null;

    try {
      // 从 V$SQLAREA 获取慢查询
      const result = await conn.oracleConnection.execute(`
        SELECT
          sql_id,
          sql_text,
          elapsed_time / executions / 1000 as avg_time_ms,
          elapsed_time / 1000 as total_time_ms,
          executions,
          first_load_time,
          last_load_time
        FROM V$SQLAREA
        WHERE executions > 0
          AND elapsed_time / executions > 1000000  -- 平均执行时间 > 1 秒 (微秒)
        ORDER BY elapsed_time DESC
        FETCH FIRST :limit ROWS ONLY
      `, { limit });

      return result.rows.map((row: any) => ({
        id: `sq-${row[0] as string}`,
        sql_text: row[1] as string,
        avg_time_ms: Math.round((row[2] as number) / 1000),
        max_time_ms: Math.round((row[3] as number) / 1000),
        execution_count: row[4] as number,
        first_seen: this._safeDate(row[5]),
        last_seen: this._safeDate(row[6]),
      }));
    } catch (error) {
      console.error(`获取 Oracle 慢查询失败：${conn.id}`, error);
      return [];
    }
  }

  /**
   * 获取达梦数据库慢查询
   */
  private async getDamengSlowQueries(conn: DatabaseConnection, limit: number): Promise<SlowQuery[] | null> {
    if (!conn.dmConnection) return null;

    try {
      // 达梦数据库使用 V$SQL_HISTORY (V$SQLAREA 在 DM8 中不可用)
      const result = await conn.dmConnection.execute(`
        SELECT
          SQL_ID as sql_id,
          TOP_SQL_TEXT as sql_text,
          TIME_USED / 1000 as avg_time_ms,
          TIME_USED / 1000 as total_time_ms,
          1 as executions,
          START_TIME as first_load_time,
          START_TIME as last_load_time
        FROM V$SQL_HISTORY
        WHERE TIME_USED > 1000000
        ORDER BY TIME_USED DESC
        FETCH FIRST :limit ROWS ONLY
      `, { limit });

      return result.rows.map((row: any) => ({
        id: `sq-${row[0] as string}`,
        sql_text: row[1] as string,
        avg_time_ms: row[2] as number,
        max_time_ms: row[3] as number,
        execution_count: row[4] as number || 1,
        first_seen: this._safeDate(row[5]),
        last_seen: this._safeDate(row[6]),
      }));
    } catch (error) {
      console.error(`获取达梦慢查询失败：${conn.id}`, error);
      return [];
    }
  }

  /**
   * Oracle QAN — V$SQLAREA query analytics
   */
  private async getOracleQueryAnalytics(conn: DatabaseConnection, limit: number): Promise<any[] | null> {
    if (!conn.oracleConnection) return null;
    try {
      const result = await conn.oracleConnection.execute(
        `SELECT * FROM (
           SELECT
             sql_text as fingerprint,
             executions as calls,
             ROUND(elapsed_time / NULLIF(executions, 0) / 1000, 2) as avg_time_ms,
             ROUND(elapsed_time / 1000, 2) as total_time_ms,
             buffer_gets as rows_examined
           FROM V$SQLAREA
           WHERE executions > 0 AND sql_text IS NOT NULL
           ORDER BY elapsed_time DESC
         ) WHERE ROWNUM <= :limit`,
        [limit]
      );
      return (result.rows || []).map((r: any) => ({
        fingerprint: (r[0] || '').substring(0, 200),
        calls: r[1] || 0,
        avg_time_ms: r[2] || 0,
        max_time_ms: 0,
        total_time_ms: r[3] || 0,
        rows_examined: r[4] || 0,
      }));
    } catch (error) {
      console.error(`获取 Oracle QAN 失败：${conn.id}`, error);
      return [];
    }
  }

  /**
   * 获取达梦查询性能分析（QAN）
   */
  private async getDamengQueryAnalytics(conn: DatabaseConnection, limit: number): Promise<any[] | null> {
    if (!conn.dmConnection) return null;
    try {
      const result = await conn.dmConnection.execute(`
        SELECT
          TOP_SQL_TEXT as fingerprint,
          COUNT(*) as calls,
          ROUND(AVG(TIME_USED) / 1000, 2) as avg_time_ms,
          ROUND(MAX(TIME_USED) / 1000, 2) as max_time_ms,
          ROUND(SUM(TIME_USED) / 1000, 2) as total_time_ms,
          0 as rows_examined
        FROM V$SQL_HISTORY
        WHERE TIME_USED > 0 AND TOP_SQL_TEXT IS NOT NULL
        GROUP BY TOP_SQL_TEXT
        ORDER BY SUM(TIME_USED) DESC
        FETCH FIRST :limit ROWS ONLY
      `, { limit });
      return (result.rows || []).map((r: any) => ({
        fingerprint: (r[0] || '').substring(0, 200),
        calls: r[1] || 0,
        avg_time_ms: r[2] || 0,
        max_time_ms: r[3] || 0,
        total_time_ms: r[4] || 0,
        rows_examined: r[5] || 0,
      }));
    } catch (error) {
      console.error(`获取达梦 QAN 失败：${conn.id}`, error);
      return [];
    }
  }

  /**
   * 执行健康检查
   */
  async checkHealth(id: number): Promise<HealthCheckResult | null> {
    const result = await this._withAutoReconnect(id, async (conn) => {
      let healthResult: HealthCheckResult | null = null;
      if (conn.db_type === 'postgresql' && conn.pgClient) {
        healthResult = await this.checkPostgreSQLHealth(conn);
      } else if (conn.db_type === 'mysql' && conn.pool) {
        healthResult = await this.checkMySQLHealth(conn);
      } else if (conn.db_type === 'oracle' && conn.oraclePool) {
        healthResult = await this.checkOracleHealth(conn);
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        healthResult = await this.checkDamengHealth(conn);
      }
      if (healthResult) {
        // 通过评分服务计算四维度加权评分
        try {
          const weights = await scoringConfigService.getWeights();
          const { dimensions, total, checks: scoredChecks } = calculateDimensionScores(healthResult.checks, conn.db_type, weights);
          healthResult.health_score = total;
          healthResult.dimensions = dimensions;
          healthResult.checks = scoredChecks;
        } catch (error) {
          console.error(`评分计算失败（实例 #${conn.id}）:`, error);
        }
      }
      return healthResult;
    }, 'checkHealth');
    if (result === null) {
      return {
        health_score: 0,
        status: 'critical',
        checks: [
          { name: '连接状态', status: 'critical', score: 0, message: '实例未连接或重连失败' },
        ],
      };
    }
    return result;
  }

  /**
   * PostgreSQL 健康检查
   */
  private async checkPostgreSQLHealth(conn: DatabaseConnection): Promise<HealthCheckResult> {
    const checks = [];
    let totalScore = 100;

    // 检查连接状态
    try {
      await conn.pgClient!.query('SELECT 1');
      checks.push({
        name: '连接状态',
        status: 'ok',
        score: 100,
        message: '连接正常',
      });
    } catch (e) {
      checks.push({
        name: '连接状态',
        status: 'critical',
        score: 0,
        message: '无法连接',
      });
      totalScore -= 100;
    }

    // 获取数据库版本
    let dbVersion: string | null = null;
    try {
      const verResult = await conn.pgClient!.query<{ version: string }>('SELECT version()');
      dbVersion = verResult.rows[0]?.version?.match(/PostgreSQL ([\d.]+)/)?.[1] || verResult.rows[0]?.version?.split(',')[0]?.replace('PostgreSQL ', '') || null;
    } catch { /* ignore */ }

    // 获取数据总大小
    let dataSizeGB: number | null = null;
    try {
      const sizeResult = await conn.pgClient!.query<{ size_gb: string }>(
        `SELECT COALESCE(ROUND(SUM(pg_database_size(datname)) / 1024 / 1024 / 1024, 2), 0) as size_gb
         FROM pg_database WHERE datistemplate = false`
      );
      dataSizeGB = sizeResult.rows[0]?.size_gb ? parseFloat(sizeResult.rows[0].size_gb) : null;
    } catch { /* ignore */ }

    // 检查连接数使用率
    const maxConnResult = await conn.pgClient!.query<{ setting: string }>("SHOW max_connections");
    const connResult = await conn.pgClient!.query<{ count: string }>('SELECT COUNT(*) FROM pg_stat_activity');
    const maxConnections = parseInt(maxConnResult.rows[0]?.setting || '100');
    const currentConnections = parseInt(connResult.rows[0]?.count || '0');
    const usagePercent = (currentConnections / maxConnections) * 100;

    let connStatus = 'ok';
    let connScore = 100;
    let connMessage = '连接数正常';
    if (usagePercent > 80) {
      connStatus = 'critical';
      connScore = 40;
      connMessage = `连接数使用率过高：${usagePercent.toFixed(1)}%`;
      totalScore -= 30;
    } else if (usagePercent > 60) {
      connStatus = 'warning';
      connScore = 70;
      connMessage = `连接数使用率较高：${usagePercent.toFixed(1)}%`;
      totalScore -= 15;
    }

    checks.push({
      name: '连接数使用率',
      status: connStatus,
      score: connScore,
      message: connMessage,
    });

    // 检查缓存命中率 - 动态检测可用列
    const colCheck = await conn.pgClient!.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'pg_catalog' AND table_name = 'pg_stat_database'
    `);
    const availCols = new Set(colCheck.rows.map((r: any) => r.column_name));
    const readCol = availCols.has('blks_read') ? 'blks_read' : (availCols.has('blk_read') ? 'blk_read' : null);
    const hitCol = availCols.has('blks_hit') ? 'blks_hit' : (availCols.has('blk_hit') ? 'blk_hit' : null);

    const dbStatsResult = await conn.pgClient!.query(`
      SELECT
        ${readCol ? `SUM(${readCol}) as blk_read` : '0 as blk_read'},
        ${hitCol ? `SUM(${hitCol}) as blk_hit` : '0 as blk_hit'}
      FROM pg_stat_database
      WHERE datname = current_database()
    `);
    const blkRead = parseInt(dbStatsResult.rows[0]?.blk_read || '0');
    const blkHit = parseInt(dbStatsResult.rows[0]?.blk_hit || '0');
    const totalBlk = blkRead + blkHit;
    const cacheHitRate = totalBlk > 0 ? (blkHit / totalBlk * 100) : 100;

    let cacheStatus = 'ok';
    let cacheScore = 100;
    let cacheMessage = `缓存命中率：${cacheHitRate.toFixed(2)}%`;
    if (cacheHitRate < 80) {
      cacheStatus = 'critical';
      cacheScore = 40;
      cacheMessage = `缓存命中率过低：${cacheHitRate.toFixed(2)}%`;
      totalScore -= 30;
    } else if (cacheHitRate < 90) {
      cacheStatus = 'warning';
      cacheScore = 70;
      cacheMessage = `缓存命中率较低：${cacheHitRate.toFixed(2)}%`;
      totalScore -= 15;
    }

    checks.push({
      name: '缓存命中率',
      status: cacheStatus,
      score: cacheScore,
      message: cacheMessage,
    });

    // 检查死锁
    const deadlocksResult = await conn.pgClient!.query(`
      SELECT SUM(deadlocks) as deadlocks FROM pg_stat_database WHERE datname = current_database()
    `);
    const deadlocks = parseInt(deadlocksResult.rows[0]?.deadlocks || '0');

    let deadlockStatus = 'ok';
    let deadlockScore = 100;
    let deadlockMessage = '无死锁';
    if (deadlocks > 10) {
      deadlockStatus = 'warning';
      deadlockScore = 70;
      deadlockMessage = `存在 ${deadlocks} 次死锁`;
      totalScore -= 15;
    }

    checks.push({
      name: '死锁检测',
      status: deadlockStatus,
      score: deadlockScore,
      message: deadlockMessage,
    });

    totalScore = Math.max(0, totalScore);

    return {
      health_score: totalScore,
      status: totalScore >= 80 ? 'healthy' : totalScore >= 60 ? 'warning' : 'critical',
      checks,
    };
  }

  /**
   * MySQL 健康检查
   */
  private async checkMySQLHealth(conn: DatabaseConnection): Promise<HealthCheckResult> {
    const checks = [];
    let totalScore = 100;

    // 检查连接状态
    try {
      const [result] = await conn.pool!.query<RowDataPacket[]>('SELECT 1');
      checks.push({
        name: '连接状态',
        status: 'ok',
        score: 100,
        message: '连接正常',
      });
    } catch (e) {
      checks.push({
        name: '连接状态',
        status: 'critical',
        score: 0,
        message: '无法连接',
      });
      totalScore -= 100;
    }

    // 获取数据库版本
    let dbVersion: string | null = null;
    try {
      const [verRows] = await conn.pool!.query<RowDataPacket[]>('SELECT VERSION() as version');
      dbVersion = verRows[0]?.version || null;
    } catch { /* ignore */ }

    // 获取数据总大小
    let dataSizeGB: number | null = null;
    try {
      const [sizeRows] = await conn.pool!.query<RowDataPacket[]>(
        `SELECT COALESCE(ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2), 0) as size_gb
         FROM information_schema.TABLES WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')`
      );
      dataSizeGB = sizeRows[0]?.size_gb || null;
    } catch { /* ignore */ }

    // 检查连接数使用率
    const [maxConn] = await conn.pool!.query<RowDataPacket[]>(
      "SHOW VARIABLES LIKE 'max_connections'"
    );
    const [processlist] = await conn.pool!.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM information_schema.PROCESSLIST'
    );
    const maxConnections = maxConn[0]?.Value || 151;
    const currentConnections = processlist[0]?.count || 0;
    const usagePercent = (currentConnections / maxConnections) * 100;

    let connStatus = 'ok';
    let connScore = 100;
    let connMessage = '连接数正常';
    if (usagePercent > 80) {
      connStatus = 'critical';
      connScore = 40;
      connMessage = `连接数使用率过高：${usagePercent.toFixed(1)}%`;
      totalScore -= 30;
    } else if (usagePercent > 60) {
      connStatus = 'warning';
      connScore = 70;
      connMessage = `连接数使用率较高：${usagePercent.toFixed(1)}%`;
      totalScore -= 15;
    }

    checks.push({
      name: '连接数使用率',
      status: connStatus,
      score: connScore,
      message: connMessage,
    });

    // 检查慢查询
    const metrics = await this.getRealtimeMetrics(conn.id);
    const slowQueries = metrics?.slow_queries || 0;
    let slowStatus = 'ok';
    let slowScore = 100;
    let slowMessage = '无慢查询';
    if (slowQueries > 10) {
      slowStatus = 'warning';
      slowScore = 70;
      slowMessage = `存在 ${slowQueries} 条慢查询`;
      totalScore -= 15;
    }

    checks.push({
      name: '慢查询',
      status: slowStatus,
      score: slowScore,
      message: slowMessage,
    });

    totalScore = Math.max(0, totalScore);

    return {
      health_score: totalScore,
      status: totalScore >= 80 ? 'healthy' : totalScore >= 60 ? 'warning' : 'critical',
      checks,
      db_version: dbVersion,
      data_size_gb: dataSizeGB,
    };
  }

  /**
   * Oracle 健康检查
   */
  private async checkOracleHealth(conn: DatabaseConnection): Promise<HealthCheckResult> {
    const checks = [];
    let totalScore = 100;

    if (!conn.oracleConnection) {
      return {
        health_score: 0,
        status: 'critical',
        checks: [{ name: 'Oracle 检查', status: 'critical', score: 0, message: '未连接' }],
      };
    }

    try {
      // 检查连接状态
      try {
        await conn.oracleConnection.execute('SELECT 1 FROM DUAL');
        checks.push({
          name: '连接状态',
          status: 'ok',
          score: 100,
          message: '连接正常',
        });
      } catch (e) {
        checks.push({
          name: '连接状态',
          status: 'critical',
          score: 0,
          message: '无法连接',
        });
        totalScore -= 100;
      }

      // 检查连接数使用率
      let connStatus = 'ok';
      let connScore = 100;
      let connMessage = '连接数正常';
      try {
        const maxConnResult = await conn.oracleConnection.execute(
          "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'processes'"
        );
        const connResult = await conn.oracleConnection.execute(
          'SELECT COUNT(*) as count FROM V$SESSION'
        );
        const maxConnections = maxConnResult.rows[0]?.[0] as number || 300;
        const currentConnections = connResult.rows[0]?.[0] as number || 0;
        const usagePercent = (currentConnections / maxConnections) * 100;

        if (usagePercent > 80) {
          connStatus = 'critical';
          connScore = 40;
          connMessage = `连接数使用率过高：${usagePercent.toFixed(1)}%`;
          totalScore -= 30;
        } else if (usagePercent > 60) {
          connStatus = 'warning';
          connScore = 70;
          connMessage = `连接数使用率较高：${usagePercent.toFixed(1)}%`;
          totalScore -= 15;
        }
      } catch {
        console.warn(`[OracleHealth] V$PARAMETER/V$SESSION 查询失败，连接数检查跳过`);
        connMessage = '连接数使用率：不可用（V$ 视图权限不足）';
      }

      checks.push({
        name: '连接数使用率',
        status: connStatus,
        score: connScore,
        message: connMessage,
      });

      // 检查表空间使用率
      let tablespaceUsage = null;
      try {
        const tablespaceResult = await conn.oracleConnection.execute(`
          SELECT MAX(usage_percent) FROM (
            SELECT ROUND((1 - NVL(fs.free_bytes, 0) / NULLIF(SUM(df.bytes), 0)) * 100, 2) as usage_percent
            FROM DBA_DATA_FILES df
            LEFT JOIN (
              SELECT tablespace_name, SUM(bytes) as free_bytes
              FROM DBA_FREE_SPACE GROUP BY tablespace_name
            ) fs ON fs.tablespace_name = df.tablespace_name
            WHERE df.tablespace_name NOT IN ('SYSTEM', 'SYSAUX')
            GROUP BY df.tablespace_name, fs.free_bytes
          )
        `);
        tablespaceUsage = tablespaceResult.rows[0]?.[0] as number ?? null;
      } catch {
        console.warn(`[OracleHealth] DBA 视图权限不足，表空间使用率不可用`);
        tablespaceUsage = null;
      }

      let tsStatus = 'ok';
      let tsScore = 100;
      let tsMessage: string;
      if (tablespaceUsage === null) {
        tsMessage = '表空间使用率：不可用（DBA 权限不足）';
      } else {
        tsMessage = `表空间使用率：${tablespaceUsage.toFixed(1)}%`;
        if (tablespaceUsage > 90) {
          tsStatus = 'critical';
          tsScore = 40;
          tsMessage = `表空间使用率过高：${tablespaceUsage.toFixed(1)}%`;
          totalScore -= 30;
        } else if (tablespaceUsage > 80) {
          tsStatus = 'warning';
          tsScore = 70;
          tsMessage = `表空间使用率较高：${tablespaceUsage.toFixed(1)}%`;
          totalScore -= 15;
        }
      }

      checks.push({
        name: '表空间使用率',
        status: tsStatus,
        score: tsScore,
        message: tsMessage,
      });

      // 检查库缓存命中率
      let libraryCacheHitRate = 100;
      try {
        const libraryCacheResult = await conn.oracleConnection.execute(`
          SELECT ROUND(SUM(pinhits) / NULLIF(SUM(pins), 0) * 100, 2) as hit_rate
          FROM V$LIBRARYCACHE
        `);
        libraryCacheHitRate = libraryCacheResult.rows[0]?.[0] as number || 100;
      } catch {
        console.warn(`[OracleHealth] V$LIBRARYCACHE 查询失败，库缓存检查跳过`);
        libraryCacheHitRate = 100;
      }

      let cacheStatus = 'ok';
      let cacheScore = 100;
      let cacheMessage = `库缓存命中率：${libraryCacheHitRate.toFixed(2)}%`;
      if (libraryCacheHitRate < 80) {
        cacheStatus = 'critical';
        cacheScore = 40;
        cacheMessage = `库缓存命中率过低：${libraryCacheHitRate.toFixed(2)}%`;
        totalScore -= 30;
      } else if (libraryCacheHitRate < 90) {
        cacheStatus = 'warning';
        cacheScore = 70;
        cacheMessage = `库缓存命中率较低：${libraryCacheHitRate.toFixed(2)}%`;
        totalScore -= 15;
      }

      checks.push({
        name: '库缓存命中率',
        status: cacheStatus,
        score: cacheScore,
        message: cacheMessage,
      });

      // 检查死锁
      let enqueueDeadlocks = 0;
      try {
        const deadlockResult = await conn.oracleConnection.execute(
          "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
        );
        enqueueDeadlocks = deadlockResult.rows[0]?.[0] as number || 0;
      } catch {
        console.warn(`[OracleHealth] V$LOCK 查询失败，死锁检查跳过`);
      }

      let deadlockStatus = 'ok';
      let deadlockScore = 100;
      let deadlockMessage = '无死锁';
      if (enqueueDeadlocks > 10) {
        deadlockStatus = 'warning';
        deadlockScore = 70;
        deadlockMessage = `存在 ${enqueueDeadlocks} 次死锁`;
        totalScore -= 15;
      }

      checks.push({
        name: '死锁检测',
        status: deadlockStatus,
        score: deadlockScore,
        message: deadlockMessage,
      });

      totalScore = Math.max(0, totalScore);

      // 获取 Oracle 版本号
      let dbVersion: string | null = null;
      try {
        const versionResult = await conn.oracleConnection.execute(
          "SELECT VERSION FROM V$INSTANCE"
        );
        dbVersion = versionResult.rows[0]?.[0] as string || null;
      } catch {
        dbVersion = null;
      }

      let dataSizeGB: number | null = null;
      try {
        const dsResult = await conn.oracleConnection.execute(
          "SELECT ROUND(SUM(bytes)/1024/1024/1024, 2) FROM DBA_DATA_FILES"
        );
        dataSizeGB = dsResult.rows[0]?.[0] as number || null;
      } catch {
        // DBA_DATA_FILES 可能无权限 — 优雅降级
        dataSizeGB = null;
      }

      return {
        health_score: totalScore,
        status: totalScore >= 80 ? 'healthy' : totalScore >= 60 ? 'warning' : 'critical',
        checks,
        db_version: dbVersion,
        data_size_gb: dataSizeGB,
      };
    } catch (error) {
      console.error(`Oracle 健康检查失败：${conn.id}`, error);
      return {
        health_score: 0,
        status: 'critical',
        checks: [
          {
            name: 'Oracle 检查',
            status: 'critical',
            score: 0,
            message: `检查失败：${error instanceof Error ? error.message : '未知错误'}`,
          },
        ],
      };
    }
  }

  /**
   * 达梦数据库健康检查
   */
  private async checkDamengHealth(conn: DatabaseConnection): Promise<HealthCheckResult> {
    const checks = [];
    let totalScore = 100;

    if (!conn.dmConnection) {
      return {
        health_score: 0,
        status: 'critical',
        checks: [{ name: '达梦检查', status: 'critical', score: 0, message: '未连接' }],
      };
    }

    try {
      // 检查连接状态
      try {
        await conn.dmConnection.execute('SELECT 1 FROM DUAL');
        checks.push({
          name: '连接状态',
          status: 'ok',
          score: 100,
          message: '连接正常',
        });
      } catch (e) {
        checks.push({
          name: '连接状态',
          status: 'critical',
          score: 0,
          message: '无法连接',
        });
        totalScore -= 100;
      }

      // 检查连接数使用率
      const maxConnResult = await conn.dmConnection.execute(
        "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'"
      );
      const connResult = await conn.dmConnection.execute(
        'SELECT COUNT(*) as count FROM V$SESSIONS'
      );
      const maxConnections = maxConnResult.rows[0]?.[0] as number || 500;
      const currentConnections = connResult.rows[0]?.[0] as number || 0;
      const usagePercent = (currentConnections / maxConnections) * 100;

      let connStatus = 'ok';
      let connScore = 100;
      let connMessage = '连接数正常';
      if (usagePercent > 80) {
        connStatus = 'critical';
        connScore = 40;
        connMessage = `连接数使用率过高：${usagePercent.toFixed(1)}%`;
        totalScore -= 30;
      } else if (usagePercent > 60) {
        connStatus = 'warning';
        connScore = 70;
        connMessage = `连接数使用率较高：${usagePercent.toFixed(1)}%`;
        totalScore -= 15;
      }

      checks.push({
        name: '连接数使用率',
        status: connStatus,
        score: connScore,
        message: connMessage,
      });

      // 检查缓冲池命中率 (Dameng uses V$BUFFERPOOL with RAT_HIT column)
      const bufferResult = await conn.dmConnection.execute(`
        SELECT NVL(RAT_HIT, 0) * 100 as hit_rate
        FROM V$BUFFERPOOL
        WHERE ID = 0
      `);
      const bufferHitRate = bufferResult.rows[0]?.[0] as number || 100;

      let bufferStatus = 'ok';
      let bufferScore = 100;
      let bufferMessage = `缓冲池命中率：${bufferHitRate.toFixed(2)}%`;
      if (bufferHitRate < 80) {
        bufferStatus = 'critical';
        bufferScore = 40;
        bufferMessage = `缓冲池命中率过低：${bufferHitRate.toFixed(2)}%`;
        totalScore -= 30;
      } else if (bufferHitRate < 90) {
        bufferStatus = 'warning';
        bufferScore = 70;
        bufferMessage = `缓冲池命中率较低：${bufferHitRate.toFixed(2)}%`;
        totalScore -= 15;
      }

      checks.push({
        name: '缓冲池命中率',
        status: bufferStatus,
        score: bufferScore,
        message: bufferMessage,
      });

      // 检查锁等待
      let lockWaitCount = 0;
      try {
        const lockWaitResult = await conn.dmConnection.execute(
          "SELECT COUNT(*) as count FROM V$LOCK WHERE BLOCK = 1"
        );
        lockWaitCount = lockWaitResult.rows[0]?.[0] as number || 0;
      } catch {
        try {
          const lockResult = await conn.dmConnection.execute(
            "SELECT COUNT(*) as count FROM V$LOCK"
          );
          lockWaitCount = lockResult.rows[0]?.[0] as number || 0;
        } catch {
          lockWaitCount = 0;
        }
      }

      let lockStatus = 'ok';
      let lockScore = 100;
      let lockMessage = '无锁等待';
      if (lockWaitCount > 5) {
        lockStatus = 'warning';
        lockScore = 70;
        lockMessage = `存在 ${lockWaitCount} 次锁等待`;
        totalScore -= 15;
      }

      checks.push({
        name: '锁等待检测',
        status: lockStatus,
        score: lockScore,
        message: lockMessage,
      });

      // 检查死锁
      try {
        const deadlockResult = await conn.dmConnection.execute(
          "SELECT COUNT(*) as count FROM V$DEADLOCK_HISTORY"
        );
        const deadlockCount = deadlockResult.rows[0]?.[0] as number || 0;

        let deadlockStatus = 'ok';
        let deadlockScore = 100;
        let deadlockMessage = '无死锁';
        if (deadlockCount > 0) {
          deadlockStatus = 'warning';
          deadlockScore = 70;
          deadlockMessage = `存在 ${deadlockCount} 次未解决死锁`;
          totalScore -= 15;
        }

        checks.push({
          name: '死锁检测',
          status: deadlockStatus,
          score: deadlockScore,
          message: deadlockMessage,
        });
      } catch (e) {
        // V$DEADLOCK_HISTORY 可能不存在，跳过此检查
        checks.push({
          name: '死锁检测',
          status: 'warning',
          score: 100,
          message: '无法获取死锁信息',
        });
      }

      totalScore = Math.max(0, totalScore);

      let dbVersion: string | null = null;
      try {
        const verResult = await conn.dmConnection.execute("SELECT TRIM(REPLACE(SVR_VERSION, 'DM Database Server x64 ', '')) AS version FROM V$INSTANCE");
        dbVersion = verResult.rows[0]?.[0] as string || null;
      } catch { /* ignore */ }

      let dataSizeGB: number | null = null;
      try {
        const sizeResult = await conn.dmConnection.execute(
          "SELECT ROUND(SUM(BYTES) * 1.0 / 1024 / 1024 / 1024, 2) as size_gb FROM DBA_DATA_FILES"
        );
        dataSizeGB = sizeResult.rows[0]?.[0] as number || null;
      } catch { /* ignore */ }

      return {
        health_score: totalScore,
        status: totalScore >= 80 ? 'healthy' : totalScore >= 60 ? 'warning' : 'critical',
        checks,
        db_version: dbVersion,
        data_size_gb: dataSizeGB,
      };
    } catch (error) {
      console.error(`达梦数据库健康检查失败：${conn.id}`, error);
      return {
        health_score: 0,
        status: 'critical',
        checks: [
          {
            name: '达梦检查',
            status: 'critical',
            score: 0,
            message: `检查失败：${error instanceof Error ? error.message : '未知错误'}`,
          },
        ],
      };
    }
  }

  /**
   * 获取数据库 schema 对象树（用于 SQL 控制台浏览器）
   */
  async getSchemaObjects(id: number): Promise<Array<{
    schema: string;
    tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }> }>;
  }> | null> {
    return this._withAutoReconnect(id, async (conn) => {
      try {
        if (conn.db_type === 'mysql' && conn.pool) {
          const [tables] = await conn.pool.query<any[]>(
            `SELECT TABLE_SCHEMA as s, TABLE_NAME as t
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')
             ORDER BY TABLE_SCHEMA, TABLE_NAME`
          );
          const [cols] = await conn.pool.query<any[]>(
            `SELECT TABLE_SCHEMA as s, TABLE_NAME as t, COLUMN_NAME as c, COLUMN_TYPE as type, IS_NULLABLE as n
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')
             ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
          );
          const schemaMap = new Map<string, Map<string, Array<{ name: string; type: string; nullable: boolean }>>>();
          for (const t of tables) {
            if (!schemaMap.has(t.s)) schemaMap.set(t.s, new Map());
            schemaMap.get(t.s)!.set(t.t, []);
          }
          for (const c of cols) {
            const tables = schemaMap.get(c.s);
            if (tables?.has(c.t)) {
              tables.get(c.t)!.push({ name: c.c, type: c.type, nullable: c.n === 'YES' });
            }
          }
          return [...schemaMap].map(([schema, tables]) => ({
            schema,
            tables: [...tables].map(([name, columns]) => ({ name, columns })),
          }));
        } else if (conn.db_type === 'postgresql' && conn.pgClient) {
          const result = await conn.pgClient.query(
            `SELECT table_schema as s, table_name as t,
                    column_name as c, data_type as type, is_nullable as n
             FROM information_schema.columns
             WHERE table_schema NOT IN ('pg_catalog','information_schema')
             ORDER BY table_schema, table_name, ordinal_position`
          );
          const schemaMap = new Map<string, Map<string, Array<{ name: string; type: string; nullable: boolean }>>>();
          for (const row of result.rows) {
            if (!schemaMap.has(row.s)) schemaMap.set(row.s, new Map());
            if (!schemaMap.get(row.s)!.has(row.t)) schemaMap.get(row.s)!.set(row.t, []);
            schemaMap.get(row.s)!.get(row.t)!.push({ name: row.c, type: row.type, nullable: row.n === 'YES' });
          }
          return [...schemaMap].map(([schema, tables]) => ({
            schema,
            tables: [...tables].map(([name, columns]) => ({ name, columns })),
          }));
        } else if (conn.db_type === 'dameng' && conn.dmConnection) {
          const result = await conn.dmConnection.execute(`
            SELECT owner as s, table_name as t, column_name as c, data_type as type, nullable as n
            FROM ALL_TAB_COLUMNS
            WHERE owner NOT IN ('SYS', 'SYSDBA', 'SYSAUDITOR')
            ORDER BY owner, table_name, column_id
          `);
          const schemaMap = new Map<string, Map<string, Array<{ name: string; type: string; nullable: boolean }>>>();
          for (const row of (result.rows || [])) {
            const s = row[0] as string;
            const t = row[1] as string;
            const c = row[2] as string;
            const type = row[3] as string;
            const n = row[4] as string;
            if (!schemaMap.has(s)) schemaMap.set(s, new Map());
            if (!schemaMap.get(s)!.has(t)) schemaMap.get(s)!.set(t, []);
            schemaMap.get(s)!.get(t)!.push({ name: c, type, nullable: n === 'YES' });
          }
          return [...schemaMap].map(([schema, tables]) => ({
            schema,
            tables: [...tables].map(([name, columns]) => ({ name, columns })),
          }));
        } else if (conn.db_type === 'oracle' && conn.oracleConnection) {
          const result = await conn.oracleConnection.execute(`
            SELECT owner as s, table_name as t, column_name as c, data_type as type, nullable as n
            FROM ALL_TAB_COLUMNS
            WHERE owner NOT IN ('SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'XDB', 'APPQOSSYS', 'ORACLE_OCM', 'GSMADMIN_INTERNAL')
            ORDER BY owner, table_name, column_id
          `);
          const schemaMap = new Map<string, Map<string, Array<{ name: string; type: string; nullable: boolean }>>>();
          for (const row of (result.rows || [])) {
            const s = String(row[0] || '');
            const t = String(row[1] || '');
            const c = String(row[2] || '');
            const type = String(row[3] || '');
            const n = String(row[4] || '');
            if (!schemaMap.has(s)) schemaMap.set(s, new Map());
            if (!schemaMap.get(s)!.has(t)) schemaMap.get(s)!.set(t, []);
            schemaMap.get(s)!.get(t)!.push({ name: c, type, nullable: n === 'YES' });
          }
          return [...schemaMap].map(([schema, tables]) => ({
            schema,
            tables: [...tables].map(([name, columns]) => ({ name, columns })),
          }));
        }
        return [];
      } catch (e) { console.error('getSchemaObjects failed:', e); return null; }
    }, 'getSchemaObjects');
  }

  /**
   * 查询性能分析（QAN）— 按指纹聚合的 TOP N 查询
   */
  async getQueryAnalytics(id: number, limit: number = 20): Promise<Array<{
    fingerprint: string;
    calls: number;
    avg_time_ms: number;
    max_time_ms: number;
    total_time_ms: number;
    rows_examined: number;
  }> | null> {
    return this._withAutoReconnect(id, async (conn) => {
      try {
        if (conn.db_type === 'mysql' && conn.pool) {
          const [rows] = await conn.pool.query<RowDataPacket[]>(
            `SELECT DIGEST_TEXT as fingerprint, COUNT_STAR as calls,
                    ROUND(AVG_TIMER_WAIT/1000000000, 2) as avg_time_ms,
                    ROUND(MAX_TIMER_WAIT/1000000000, 2) as max_time_ms,
                    ROUND(SUM_TIMER_WAIT/1000000000, 2) as total_time_ms,
                    SUM_ROWS_EXAMINED as rows_examined
             FROM performance_schema.events_statements_summary_by_digest
             WHERE DIGEST_TEXT IS NOT NULL AND SCHEMA_NAME NOT IN ('mysql','sys','performance_schema')
             ORDER BY SUM_TIMER_WAIT DESC LIMIT ?`,
            [limit]
          );
          return (rows as any[]).map(r => ({ ...r, fingerprint: r.fingerprint || '' }));
        } else if (conn.db_type === 'postgresql' && conn.pgClient) {
          const result = await conn.pgClient.query(
            `SELECT query as fingerprint, calls,
                    ROUND(mean_exec_time::numeric, 2) as avg_time_ms,
                    ROUND(max_exec_time::numeric, 2) as max_time_ms,
                    ROUND(total_exec_time::numeric, 2) as total_time_ms,
                    rows as rows_examined
             FROM pg_stat_statements
             WHERE query NOT LIKE '%pg_stat%'
             ORDER BY total_exec_time DESC LIMIT $1`,
            [limit]
          );
          return result.rows.map(r => ({ ...r, fingerprint: r.fingerprint || '' }));
        } else if (conn.db_type === 'oracle' && conn.oracleConnection) {
          return this.getOracleQueryAnalytics(conn, limit);
        } else if (conn.db_type === 'dameng' && conn.dmConnection) {
          return this.getDamengQueryAnalytics(conn, limit);
        }
        return null;
      } catch (error) {
        console.error(`获取 QAN 数据失败：${id}`, error);
        return null;
      }
    }, 'getQueryAnalytics');
  }

  /**
   * 获取 SQL 执行计划
   */
  async getExplainPlan(id: number, sql: string): Promise<string | null> {
    return this._withAutoReconnect(id, async (conn) => {
      if (conn.db_type === 'mysql' && conn.pool) {
        return this.getMySQLExplainPlan(conn, sql);
      } else if (conn.db_type === 'postgresql' && conn.pgClient) {
        return this.getPostgreSQLExplainPlan(conn, sql);
      } else if (conn.db_type === 'oracle' && conn.oraclePool) {
        return this.getOracleExplainPlan(conn, sql);
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        return this.getDamengExplainPlan(conn, sql);
      }
      return null;
    }, 'getExplainPlan');
  }

  /**
   * 获取 SQL 执行计划（JSON 格式）
   */
  async getExplainPlanJson(id: number, sql: string): Promise<{ plan: any; db_type: string } | null> {
    const conn = this.connections.get(id);
    if (!conn || !conn.connected) return null;

    const dbType = conn.db_type;

    if (dbType === 'mysql' && conn.pool) {
      try {
        const [result] = await conn.pool.query<RowDataPacket[]>(`EXPLAIN FORMAT=JSON ${sql}`);
        // MySQL returns [{ "EXPLAIN": "{...json...}" }] — parse the nested JSON string
        const raw = (result as any[])[0]?.EXPLAIN;
        return { plan: typeof raw === 'string' ? JSON.parse(raw) : raw, db_type: 'mysql' };
      } catch (error: any) {
        console.error(`获取 MySQL EXPLAIN JSON 失败：${conn.id}`, error);
        return { plan: { error: error.message }, db_type: 'mysql' };
      }
    } else if (dbType === 'postgresql' && conn.pgClient) {
      try {
        const result = await conn.pgClient.query(`EXPLAIN (FORMAT JSON) ${sql}`);
        return { plan: result.rows[0]?.['QUERY PLAN'] || [], db_type: 'postgresql' };
      } catch (error: any) {
        console.error(`获取 PG EXPLAIN JSON 失败：${conn.id}`, error);
        return { plan: { error: error.message }, db_type: 'postgresql' };
      }
    } else if (dbType === 'dameng' && conn.dmConnection) {
      try {
        const textPlan = await this.getDamengExplainPlan(conn, sql);
        return { plan: { query_plan: { operation: 'EXPLAIN', text: String(textPlan) } }, db_type: 'dameng' };
      } catch (error: any) {
        return { plan: { error: error.message }, db_type: 'dameng' };
      }
    }

    return { plan: { error: `EXPLAIN JSON 不支持此数据库类型: ${dbType}` }, db_type: dbType };
  }

  /**
   * 获取 MySQL 执行计划
   */
  private async getMySQLExplainPlan(conn: DatabaseConnection, sql: string): Promise<string | null> {
    if (!conn.pool) return null;

    try {
      const [result] = await conn.pool.query<RowDataPacket[]>(`EXPLAIN ${sql}`);

      // 格式化为文本格式
      let output = 'MySQL 执行计划:\n';
      output += '='.repeat(80) + '\n';

      for (const row of result) {
        output += `ID: ${row.id || 'N/A'}\n`;
        output += `  表：${row.table || 'N/A'}\n`;
        output += `  类型：${row.type || row.access_type || 'N/A'}\n`;
        output += `  可能的键：${row.possible_keys || 'N/A'}\n`;
        output += `  使用的键：${row.key || 'N/A'}\n`;
        output += `  键长度：${row.key_len || 'N/A'}\n`;
        output += `  引用：${row.ref || 'N/A'}\n`;
        output += `  行数：${row.rows || 'N/A'}\n`;
        output += `  额外信息：${row.Extra || 'N/A'}\n`;
        output += '-'.repeat(40) + '\n';
      }

      return output;
    } catch (error) {
      console.error(`获取 MySQL 执行计划失败：${conn.id}`, error);
      return `获取执行计划失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  /**
   * 获取 PostgreSQL 执行计划
   */
  private async getPostgreSQLExplainPlan(conn: DatabaseConnection, sql: string): Promise<string | null> {
    if (!conn.pgClient) return null;

    try {
      // 使用 EXPLAIN ANALYZE 获取实际执行计划
      const result = await conn.pgClient.query(`EXPLAIN ANALYZE ${sql}`);

      // PostgreSQL 返回的是文本格式的执行计划
      let output = 'PostgreSQL 执行计划:\n';
      output += '='.repeat(80) + '\n';

      for (const row of result.rows) {
        output += row['QUERY PLAN'] || row.query_plan || JSON.stringify(row) + '\n';
      }

      return output;
    } catch (error) {
      console.error(`获取 PostgreSQL 执行计划失败：${conn.id}`, error);
      return `获取执行计划失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  /**
   * 获取 Oracle 执行计划
   */
  private async getOracleExplainPlan(conn: DatabaseConnection, sql: string): Promise<string | null> {
    if (!conn.oracleConnection) return null;

    try {
      const planId = `PLAN_${Date.now()}`;

      // 尝试使用 PLAN_TABLE 方式 (Pitfall 2: PLAN_TABLE 可能不存在)
      try {
        await conn.oracleConnection.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :id`, [planId]);
        await conn.oracleConnection.execute(`EXPLAIN PLAN SET STATEMENT_ID = :id FOR ${sql}`, [planId]);
      } catch (planTableError) {
        const msg = (planTableError as Error).message || '';
        if (msg.includes('ORA-00942') || msg.includes('PLAN_TABLE') || msg.includes('table or view does not exist')) {
          return `执行计划无法生成：PLAN_TABLE 不存在。\n请 DBA 运行 @$ORACLE_HOME/rdbms/admin/utlxplan.sql 创建 PLAN_TABLE。\n\n或者使用 DBMS_XPLAN.DISPLAY_CURSOR 查看最近执行计划：\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR());`;
        }
        throw planTableError;
      }

      // 使用 DBMS_XPLAN 获取格式化的执行计划
      const result = await conn.oracleConnection.execute(`
        SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(null, :id, 'ALL'))
      `, [planId]);

      let output = 'Oracle 执行计划:\n';
      output += '='.repeat(80) + '\n';

      for (const row of result.rows) {
        const planLine = row[0] as string || row.PLAN_TABLE_OUTPUT as string;
        if (planLine) {
          output += planLine + '\n';
        }
      }

      // 清理执行计划
      await conn.oracleConnection.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :id`, [planId]);

      return output;
    } catch (error) {
      console.error(`获取 Oracle 执行计划失败：${conn.id}`, error);
      return `获取执行计划失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  /**
   * 获取达梦数据库执行计划
   */
  private async getDamengExplainPlan(conn: DatabaseConnection, sql: string): Promise<string | null> {
    if (!conn.dmConnection) return null;

    try {
      // 验证 SQL 为 SELECT 或 WITH 查询（防止 SQL 注入）
      const normalized = sql.trim().toUpperCase();
      if (!/^SELECT\s/.test(normalized) && !/^WITH\s/.test(normalized)) {
        return '执行计划仅支持 SELECT / WITH 查询';
      }
      // 防御性检查：拒绝包含分号或 DML/DDL 关键字的 SQL
      if (/[;]/.test(sql) || /\b(DROP\s|DELETE\s|INSERT\s|UPDATE\s|ALTER\s|CREATE\s|TRUNCATE\s)/i.test(sql)) {
        return '执行计划仅支持 SELECT / WITH 查询';
      }

      // 达梦数据库使用类似 Oracle 的方式
      const planId = `PLAN_${Date.now()}`;

      // 清空之前的执行计划
      await conn.dmConnection.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :id`, [planId]);

      // 解释 SQL 语句
      await conn.dmConnection.execute(`EXPLAIN PLAN SET STATEMENT_ID = :id FOR ${sql}`, [planId]);

      // 获取格式化的执行计划
      const result = await conn.dmConnection.execute(`
        SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(null, :id, 'ALL'))
      `, [planId]);

      let output = '达梦数据库执行计划:\n';
      output += '='.repeat(80) + '\n';

      for (const row of result.rows) {
        const planLine = row[0] as string || row.PLAN_TABLE_OUTPUT as string;
        if (planLine) {
          output += planLine + '\n';
        }
      }

      // 清理执行计划
      await conn.dmConnection.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :id`, [planId]);

      return output;
    } catch (error) {
      console.error(`获取达梦执行计划失败：${conn.id}`, error);
      return `获取执行计划失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  /**
   * 获取活动会话列表
   */
  async getActiveSessions(id: number): Promise<any[] | null> {
    return this._withAutoReconnect(id, async (conn) => {
      try {
        if (conn.db_type === 'mysql') {
          return await this.getMySQLActiveSessions(conn);
        } else if (conn.db_type === 'postgresql') {
          return await this.getPostgreSQLActiveSessions(conn);
        } else if (conn.db_type === 'oracle' && conn.oraclePool) {
          return await this.getOracleActiveSessions(conn);
        } else if (conn.db_type === 'dameng' && conn.dmConnection) {
          return await this.getDamengActiveSessions(conn);
        }
        return [];
      } catch (error) {
        console.error(`获取活动会话失败：${id}`, error);
        return null;
      }
    }, 'getActiveSessions');
  }

  /**
   * 获取 MySQL 活动会话
   */
  private async getMySQLActiveSessions(conn: DatabaseConnection): Promise<any[]> {
    if (!conn.pool) return [];

    const [rows] = await conn.pool.execute<RowDataPacket[]>(`
      SELECT
        ID as id,
        USER as \`user\`,
        HOST as host,
        DB as \`database\`,
        COMMAND as command,
        TIME as time_seconds,
        STATE as state,
        INFO as query
      FROM information_schema.PROCESSLIST
      WHERE COMMAND != 'Sleep'
        AND ID != CONNECTION_ID()
      ORDER BY TIME DESC
      LIMIT 50
    `);

    return rows.map((row: any) => ({
      id: row.id,
      user: row.user,
      host: row.host,
      database: row.database || null,
      command: row.command,
      time_seconds: Number(row.time_seconds) || 0,
      state: row.state,
      query: row.query?.substring(0, 200) || null,
    }));
  }

  /**
   * 获取 PostgreSQL 活动会话
   */
  private async getPostgreSQLActiveSessions(conn: DatabaseConnection): Promise<any[]> {
    if (!conn.pgClient) return [];

    const result = await conn.pgClient.query(`
      SELECT
        pid as id,
        usename as user,
        client_addr as host,
        datname as db,
        state,
        extract(epoch from (now() - query_start))::int as time_seconds,
        left(query, 200) as query
      FROM pg_stat_activity
      WHERE state = 'active'
        AND pid != pg_backend_pid()
      ORDER BY query_start ASC
      LIMIT 50
    `);

    return result.rows.map((row: any) => ({
      id: row.id,
      user: row.user,
      host: row.host,
      database: row.db,
      command: row.state,
      time_seconds: row.time_seconds || 0,
      state: row.state,
      query: row.query,
    }));
  }

  /**
   * 获取 Oracle/Dameng 活动会话
   */
  private async getOracleActiveSessions(conn: DatabaseConnection): Promise<any[]> {
    if (!conn.oracleConnection) return [];

    let result;
    try {
      result = await conn.oracleConnection.execute(`
        SELECT * FROM (
          SELECT
            s.sid as id,
            s.serial# as serial_num,
            s.username as user,
            s.machine as host,
            s.program,
            s.status as state,
            s.sql_id,
            NULL as query,
            s.last_call_et as time_seconds
          FROM V$SESSION s
          WHERE s.status = 'ACTIVE'
            AND s.type = 'USER'
          ORDER BY s.last_call_et DESC
        ) WHERE ROWNUM <= 50
      `);
    } catch {
      return [];
    }

    return (result.rows || []).map((row: any) => ({
      id: row[0],
      serial_num: row[1],
      user: row[2],
      host: row[3],
      program: row[4],
      command: row[5],
      time_seconds: row[8] || 0,
      state: row[5],
      query: row[7]?.substring(0, 200) || null,
    }));
  }

  /**
   * 获取达梦活动会话 - 使用 conn.dmConnection 查询 V$SESSIONS
   */
  private async getDamengActiveSessions(conn: DatabaseConnection): Promise<any[]> {
    if (!conn.dmConnection) return [];

    const result = await conn.dmConnection.execute(`
      SELECT
        s.SESS_ID as id,
        s.USER_NAME as username,
        s.CLNT_HOST as host,
        s.APPNAME as program,
        s.STATE as state,
        s.SQL_TEXT as query,
        DATEDIFF(SECOND, s.LAST_SEND_TIME, SYSDATE) as time_seconds
      FROM V$SESSIONS s
      WHERE s.STATE = 'ACTIVE'
        AND s.SESS_ID != SESSID()
      ORDER BY s.LAST_SEND_TIME DESC NULLS LAST
      FETCH FIRST 50 ROWS ONLY
    `);

    return (result.rows || []).map((row: any) => ({
      id: row[0],
      serial_num: null,
      user: row[1],
      username: row[1],
      host: row[2],
      program: row[3],
      state: row[4],
      sql_id: null,
      query: row[5],
      time_seconds: row[6],
    }));
  }

  /**
   * 获取容量信息
   */
  async getCapacityInfo(id: number): Promise<any | null> {
    return this._withAutoReconnect(id, async (conn) => {
      try {
        if (conn.db_type === 'mysql') {
          return await this.getMySQLCapacity(conn);
        } else if (conn.db_type === 'postgresql') {
          return await this.getPostgreSQLCapacity(conn);
        } else if (conn.db_type === 'oracle' && conn.oraclePool) {
          return await this.getOracleCapacity(conn);
        } else if (conn.db_type === 'dameng' && conn.dmConnection) {
          return await this.getDamengCapacity(conn);
        }
        return null;
      } catch (error) {
        console.error(`获取容量信息失败：${id}`, error);
        return null;
      }
    }, 'getCapacityInfo');
  }

  /**
   * 获取 MySQL 容量信息
   */
  private async getMySQLCapacity(conn: DatabaseConnection): Promise<any> {
    if (!conn.pool) return null;

    // 获取数据库大小
    const [dbSizeRows] = await conn.pool.execute<RowDataPacket[]>(`
      SELECT
        table_schema as db_name,
        ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) as size_gb,
        COUNT(*) as table_count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      GROUP BY table_schema
      ORDER BY size_gb DESC
    `);

    // 获取所有业务库的 Top 表
    const [tableRows] = await conn.pool.execute<RowDataPacket[]>(`
      SELECT
        table_name as name,
        table_schema as db_name,
        ROUND((data_length + index_length) / 1024 / 1024 / 1024, 2) as size_gb,
        table_rows as row_count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY (data_length + index_length) DESC
      LIMIT 20
    `);

    // 获取最大的表
    const totalSize = dbSizeRows.reduce((sum: number, row: any) => sum + (row.size_gb || 0), 0);

    return {
      total_size_gb: Math.round(totalSize * 100) / 100,
      databases: dbSizeRows.map((row: any) => ({
        name: row.db_name,
        size_gb: Number(row.size_gb),
        table_count: Number(row.table_count),
      })),
      top_tables: tableRows.map((row: any) => ({
        name: row.name,
        size_gb: Number(row.size_gb),
        row_count: Number(row.row_count),
      })),
    };
  }

  /**
   * 获取 PostgreSQL 容量信息
   */
  private async getPostgreSQLCapacity(conn: DatabaseConnection): Promise<any> {
    if (!conn.pgClient) return null;

    // 获取数据库大小
    const dbResult = await conn.pgClient.query(`
      SELECT
        datname as name,
        pg_size_pretty(pg_database_size(datname)) as size,
        ROUND(pg_database_size(datname) / 1024.0 / 1024.0 / 1024.0, 2) as size_gb
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY pg_database_size(datname) DESC
    `);

    // 获取表大小
    const tableResult = await conn.pgClient.query(`
      SELECT
        schemaname || '.' || relname as name,
        pg_size_pretty(pg_total_relation_size(relid)) as size,
        ROUND(pg_total_relation_size(relid) / 1024.0 / 1024.0 / 1024.0, 2) as size_gb,
        n_live_tup as row_count
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 20
    `);

    const totalSize = dbResult.rows.reduce((sum: number, row: any) => sum + (parseFloat(row.size_gb) || 0), 0);

    // 获取当前库的 Top 20 表（pg_stat_user_tables 只能查当前库）
    const tcResult = await conn.pgClient.query(`
      SELECT COUNT(*) as tc FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
        AND c.relkind = 'r'
    `);
    const currentDbTableCount = Number(tcResult.rows[0]?.tc) || 0;

    return {
      total_size_gb: Math.round(totalSize * 100) / 100,
      databases: dbResult.rows.map((row: any) => ({
        name: row.name,
        size_gb: parseFloat(row.size_gb),
        pretty_size: row.size,
        table_count: row.name === conn.pgClient.database ? currentDbTableCount : 0,
      })),
      top_tables: tableResult.rows.map((row: any) => ({
        name: row.name,
        size_gb: parseFloat(row.size_gb),
        pretty_size: row.size,
        row_count: row.row_count,
      })),
    };
  }

  /**
   * 获取 Oracle/Dameng 容量信息
   */
  private async getOracleCapacity(conn: DatabaseConnection): Promise<any> {
    if (!conn.oracleConnection) return null;

    // 获取表空间信息 (Pitfall 3: DBA 权限不足时降级)
    let tablespaces: Array<{ name: any; size_gb: number; max_size_gb: number; usage_percent: number }> = [];
    let segResult: any = null;

    try {
      const tsResult = await conn.oracleConnection.execute(`
        SELECT
          df.tablespace_name as name,
          ROUND(SUM(df.bytes) / 1024 / 1024 / 1024, 2) as size_gb,
          ROUND(SUM(df.bytes) / 1024 / 1024 / 1024, 2) as max_size_gb,
          ROUND((1 - NVL(fs.free_bytes, 0) / NULLIF(SUM(df.bytes), 0)) * 100, 2) as usage_percent
        FROM dba_data_files df
        LEFT JOIN (
          SELECT tablespace_name, SUM(bytes) as free_bytes
          FROM dba_free_space
          GROUP BY tablespace_name
        ) fs ON fs.tablespace_name = df.tablespace_name
        WHERE df.tablespace_name NOT IN ('SYSTEM', 'SYSAUX')
        GROUP BY df.tablespace_name, fs.free_bytes
        ORDER BY size_gb DESC
      `);

      tablespaces = (tsResult.rows || []).map((row: any) => ({
        name: row[0],
        size_gb: Number(row[1]),
        max_size_gb: Number(row[2]),
        usage_percent: Number(row[3]),
      }));
    } catch {
      console.warn(`[OracleCapacity] DBA_DATA_FILES 权限不足，表空间信息不可用 (instance ${conn.id})`);
      tablespaces = [];
    }

    // 获取最大的段（表/索引）
    try {
      segResult = await conn.oracleConnection.execute(`
        SELECT
          owner || '.' || segment_name as name,
          segment_type as type,
          ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) as size_gb
        FROM dba_segments
        WHERE segment_type IN ('TABLE', 'INDEX')
        GROUP BY owner, segment_name, segment_type
        ORDER BY size_gb DESC
        FETCH FIRST 20 ROWS ONLY
      `);
    } catch {
      console.warn(`[OracleCapacity] DBA_SEGMENTS 权限不足，段信息不可用 (instance ${conn.id})`);
      segResult = { rows: [] };
    }

    const totalSize = tablespaces.reduce((sum: number, ts: any) => sum + (ts.size_gb || 0), 0);

    return {
      total_size_gb: Math.round(totalSize * 100) / 100,
      tablespaces,
      top_tables: (segResult?.rows || []).map((row: any) => ({
        name: row[0],
        type: row[1],
        size_gb: Number(row[2]),
      })),
    };
  }

  /**
   * 获取达梦容量信息 - 使用 conn.dmConnection 查询 DBA_DATA_FILES / DBA_SEGMENTS
   */
  private async getDamengCapacity(conn: DatabaseConnection): Promise<any> {
    if (!conn.dmConnection) return null;

    // 获取表空间信息 — 使用 * 1.0 避免 Dameng 整数除法截断
    const tsResult = await conn.dmConnection.execute(`
      SELECT
        TABLESPACE_NAME as name,
        ROUND(SUM(BYTES) * 1.0 / 1024 / 1024 / 1024, 2) as size_gb,
        ROUND(SUM(DECODE(AUTOEXTENSIBLE, 'YES', MAXBYTES, BYTES)) * 1.0 / 1024 / 1024 / 1024, 2) as max_size_gb,
        ROUND((SUM(BYTES) * 1.0 / SUM(DECODE(AUTOEXTENSIBLE, 'YES', MAXBYTES, BYTES))) * 100, 2) as usage_percent
      FROM DBA_DATA_FILES
      GROUP BY TABLESPACE_NAME
      ORDER BY size_gb DESC
    `);

    // 获取最大的段（表/索引）
    const segResult = await conn.dmConnection.execute(`
      SELECT
        OWNER || '.' || SEGMENT_NAME as name,
        SEGMENT_TYPE as type,
        ROUND(SUM(BYTES) * 1.0 / 1024 / 1024 / 1024, 2) as size_gb
      FROM DBA_SEGMENTS
      WHERE OWNER = USER
        AND SEGMENT_TYPE IN ('TABLE', 'INDEX')
      GROUP BY OWNER, SEGMENT_NAME, SEGMENT_TYPE
      ORDER BY size_gb DESC
      FETCH FIRST 20 ROWS ONLY
    `);

    const tablespaces = (tsResult.rows || []).map((row: any) => ({
      name: row[0],
      size_gb: Number(row[1]),
      max_size_gb: Number(row[2]),
      usage_percent: Number(row[3]),
    }));

    const totalSize = tablespaces.reduce((sum: number, ts: any) => sum + (ts.size_gb || 0), 0);

    return {
      total_size_gb: Math.round(totalSize * 100) / 100,
      tablespaces,
      top_tables: (segResult.rows || []).map((row: any) => ({
        name: row[0],
        type: row[1],
        size_gb: Number(row[2]),
      })),
    };
  }

  /**
   * 安全日期解析 — 兼容 Oracle/MySQL 各种日期格式
   */
  private _safeDate(val: unknown): string {
    if (!val) return new Date().toISOString();
    const d = new Date(String(val));
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  /**
   * 获取所有连接
   */
  getAllConnections(): DatabaseConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * 确保连接可用 — 对 connected=false 的连接先尝试重连；
   * 对 connected=true 的连接执行一次存活探测，不可达时触发重连
   */
  async ensureConnectionAlive(id: number): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn) return false;
    if (!conn.connected) {
      return this.reconnect(id);
    }
    // connected=true 但需验证连接真的还活着
    const alive = await this.checkConnectionAlive(id);
    if (alive) return true;
    // 连接标记为 alive 但实际已死，尝试重连
    return this.reconnect(id);
  }

  /**
   * 检查数据库连接是否存活 — 对每种 DB 类型实际执行一次探测查询
   */
  async checkConnectionAlive(id: number): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn) return false;

    try {
      if (conn.db_type === 'mysql' && conn.pool) {
        const connection = await conn.pool.getConnection();
        try {
          await connection.ping();
        } finally {
          connection.release();
        }
      } else if (conn.db_type === 'postgresql' && conn.pgClient) {
        await conn.pgClient.query('SELECT 1');
      } else if (conn.db_type === 'oracle' && conn.oracleConnection) {
        await conn.oracleConnection.execute('SELECT 1 FROM DUAL');
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        await conn.dmConnection.execute('SELECT 1 FROM DUAL');
      } else {
        return false;
      }

      conn.connected = true;
      return true;
    } catch (error) {
      conn.connected = false;
      console.error(`[checkConnectionAlive] 实例 ${id} (${conn.name}) 连接不可用:`, error);
      return false;
    }
  }

  /**
   * 重建断开的数据库连接 — 先清理旧连接资源，再重建
   * 当不存在旧连接 entry 时，可通过 fallbackName + fallbackConfig 从头建连
   */
  async reconnect(id: number, fallbackName?: string, fallbackConfig?: DatabaseConfig): Promise<boolean> {
    const oldConn = this.connections.get(id);

    if (!oldConn) {
      if (!fallbackName || !fallbackConfig) return false;
      console.log(`[reconnect] 实例 ${id} (${fallbackName}) 无旧连接，尝试从头建连`);
      return this.addConnection(id, fallbackName, fallbackConfig);
    }

    const { name, config } = oldConn;

    // 先彻底清理旧连接
    await this.removeConnection(id);

    // 重建连接
    const success = await this.addConnection(id, fallbackName || name, fallbackConfig || config);
    if (success) {
      console.log(`[reconnect] 实例 ${id} (${name}) 重连成功`);
    } else {
      console.error(`[reconnect] 实例 ${id} (${name}) 重连失败`);
    }
    return success;
  }

  /**
   * 自动重连包装器 — 所有公开查询方法的统一入口
   * 自动处理"连接已死→重连→重试"周期
   */
  private async _withAutoReconnect<T>(
    id: number,
    fn: (conn: DatabaseConnection) => Promise<T | null>,
    methodName: string
  ): Promise<T | null> {
    let conn = this.connections.get(id);
    if (!conn) return null;

    // 第一步：如果 connected 标记为 false，尝试一次重连
    if (!conn.connected) {
      console.log(`[_withAutoReconnect] 实例 ${id} connected=false，尝试重连`);
      await this.reconnect(id);
      conn = this.connections.get(id);
      if (!conn || !conn.connected) return null;
    }

    // 第二步：执行实际查询
    try {
      return await fn(conn);
    } catch (error) {
      // 判断是否为连接相关错误
      const isConnError =
        (error instanceof Error && (
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('EHOSTUNREACH') ||
          error.message.includes('PROTOCOL_CONNECTION_LOST') ||
          error.message.includes('read ECONNRESET') ||
          error.message.includes('Cannot enqueue') ||
          error.message.includes('Connection lost') ||
          error.message.includes('closed connection') ||
          error.message.includes('ORA-03113') ||     // Oracle: end-of-file on communication channel
          error.message.includes('ORA-03135') ||     // Oracle: connection lost contact
          error.message.includes('ORA-00028') ||     // Oracle: your session has been killed
          error.message.includes('socket') ||         // 通用 socket 错误
          error.message.includes('not connected')     // pg: no connection
        ));

      if (!isConnError) {
        // 不是连接错误，如实记录并返回 null
        console.error(`[${methodName}] 实例 ${id} 查询失败（非连接错误）:`, error);
        return null;
      }

      // 是连接错误：标记 disconnected，重连，重试一次
      console.error(`[_withAutoReconnect] 实例 ${id} 连接错误，尝试重连后重试:`, error);
      conn.connected = false;
      await this.reconnect(id);
      conn = this.connections.get(id);
      if (!conn || !conn.connected) return null;

      try {
        return await fn(conn);
      } catch (retryError) {
        console.error(`[${methodName}] 实例 ${id} 重连后重试仍失败:`, retryError);
        return null;
      }
    }
  }
}

// 单例
export const databaseService = new DatabaseService();
