/**
 * 定时监控采集服务
 *
 * 基于 Zabbix 心跳调度模型：
 * - 每个指标有独立的 default_interval（来自 metric-registry）
 * - 单一 setInterval 心跳（5s），检查哪些实例的指标已到期
 * - 到期才采集，不会浪费
 */
import crypto from 'crypto';
import { databaseService } from './database-service';
import { metricsDatabaseService } from './metrics-database-service';
import { instanceDatabaseService } from './instance-database-service';
import { metricRegistry } from './metric-registry';
import { collectionCapabilityTracker } from './collection-capabilities';
import { unifiedCollector } from './collector';
import serverCollector from './server-collector';
import { dbConnection } from './db-connection';
import { dueStoredMetricIds, MysqlCollectionScheduleStore } from './collection-scheduler';
import type { MetricDefinition } from './metric-registry';

interface InstanceSchedule {
  lastSuccessByMetric: Map<string, number>;
}

interface MonitorConfig {
  heartbeatMs: number;
  alertThresholds: {
    cpu_usage: number;
    memory_usage: number;
    connections: number;
    qps: number;
    slow_queries: number;
  };
}

export interface InstanceCollectionResult {
  instanceId: number;
  attemptedMetricIds: string[];
  succeededMetricIds: string[];
  collectedAt: string;
}

class MonitorCollector {
  private schedule: Map<number, InstanceSchedule> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private slowQueryTimer: ReturnType<typeof setInterval> | null = null;
  private capacityTimer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private readonly lastHealthAttempt = new Map<number, number>();
  private readonly healthIntervalMs = 60_000;
  private running = false;
  private readonly instanceCollections = new Map<number, Promise<InstanceCollectionResult>>();
  private config: MonitorConfig = {
    heartbeatMs: 10000, // 10s 心跳，减少 MySQL 负载
    alertThresholds: {
      cpu_usage: 80,
      memory_usage: 85,
      connections: 100,
      qps: 5000,
      slow_queries: 10,
    },
  };
  private readonly scheduleStore = new MysqlCollectionScheduleStore(() => dbConnection.getPool() as any);

  /**
   * 启动监控采集
   */
  start(config?: Partial<MonitorConfig>) {
    if (this.running) {
      console.log('⚠️  监控采集已在运行中');
      return;
    }
    if (config) this.config = { ...this.config, ...config };

    // 心跳 —— 核心采集循环（先启动，首次 tick 会自动初始化 schedule）
    this.heartbeatTimer = setInterval(() => {
      this._tick().catch((e) => console.error('采集 tick 失败:', e));
    }, this.config.heartbeatMs);

    // 慢查询采集 —— 每 5 分钟
    this.slowQueryTimer = setInterval(() => {
      this.collectSlowQueries().catch((e) => console.error('慢查询采集失败:', e));
    }, 5 * 60 * 1000);

    // 容量数据采集 —— 每 1 小时
    this.capacityTimer = setInterval(() => {
      this.collectCapacity().catch((e) => console.error('容量数据采集失败:', e));
    }, 60 * 60 * 1000);

    // 服务器 SSH 指标采集（独立定时器）
    serverCollector.start();

    this.running = true;
    console.log('✅ 监控采集已启动（Zabbix 心跳模型）');
    console.log(`   - 心跳: 每 ${this.config.heartbeatMs / 1000}s`);
    console.log('   - 慢查询: 每 5 分钟');
    console.log('   - 容量: 每 1 小时');
    for (const [id, s] of this.schedule) {
      console.log(`   - 实例 #${id}: ${s.lastSuccessByMetric.size} 个指标已有采集状态`);
    }
  }

  /**
   * 停止监控采集
   */
  stop() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.slowQueryTimer) { clearInterval(this.slowQueryTimer); this.slowQueryTimer = null; }
    if (this.capacityTimer) { clearInterval(this.capacityTimer); this.capacityTimer = null; }

    // 服务器 SSH 指标采集
    serverCollector.stop();
    this.schedule.clear();
    this.lastHealthAttempt.clear();
    this.running = false;
    console.log('⏹️  监控采集已停止');
  }

  /**
   * 获取采集状态
   */
  getStatus() {
    return {
      running: this.running,
      heartbeatMs: this.config.heartbeatMs,
      schedule: Array.from(this.schedule.entries()).map(([id, s]) => ({
        instanceId: id,
        metrics: Array.from(s.lastSuccessByMetric.entries()).map(([metricId, lastSuccess]) => ({ metricId, lastSuccess: new Date(lastSuccess).toISOString() })),
      })),
    };
  }

  /**
   * 重建采集计划 —— registry 变更后调用
   */
  refreshSchedule() {
    this._rebuildSchedule().catch(e => console.error('刷新采集计划失败:', e));
  }

  /** Immediately collect one active instance and advance its normal schedule. */
  async collectInstanceNow(instanceId: number): Promise<InstanceCollectionResult> {
    const instance = await instanceDatabaseService.getInstanceById(instanceId);
    if (!instance || instance.status !== 'active') {
      throw new Error('INSTANCE_NOT_ACTIVE');
    }
    const definitions = metricRegistry.getByDbType(instance.db_type)
      .filter((metric) => metric.is_collected && metric.id !== 'health_score');
    return this.collectAndRecord(instance, definitions);
  }

  // ================== private ==================

  /**
   * 从 metric-registry 重建每个实例的采集间隔
   * 取该实例支持的所有指标中最小 default_interval
   */
  private async _rebuildSchedule() {
    // Rebuild schedule from scratch to prevent stale instance leaks
    const newSchedule = new Map<number, InstanceSchedule>();
    const instances = await instanceDatabaseService.getAllInstances();
    for (const inst of instances) {
      if (inst.status !== 'active') continue;
      const existing = this.schedule.get(inst.id);
      newSchedule.set(inst.id, existing ?? { lastSuccessByMetric: new Map() });
    }
    this.schedule = newSchedule;
  }

  /**
   * 心跳：检查哪些实例到期，采集它们
   */
  private async _tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = Date.now();
      const instances = await instanceDatabaseService.getAllInstances();
      const activeIds = new Set(instances.filter(inst => inst.status === 'active').map(inst => inst.id));
      for (const id of this.lastHealthAttempt.keys()) {
        if (!activeIds.has(id)) this.lastHealthAttempt.delete(id);
      }

      for (const inst of instances) {
        if (inst.status !== 'active') continue;

        try {
          // Health has its own cadence, including engines with no due metrics.
          const lastHealth = this.lastHealthAttempt.get(inst.id);
          if (lastHealth === undefined || now - lastHealth >= this.healthIntervalMs) {
            this.lastHealthAttempt.set(inst.id, now);
            await this.collectInstanceMetrics(inst, []);
          }
          const definitions = metricRegistry.getByDbType(inst.db_type)
            .filter((metric) => metric.is_collected && metric.id !== 'health_score');
          const dueIds = await dueStoredMetricIds(this.scheduleStore, 'instance', inst.id, 'unified', definitions, now);
          const due = definitions.filter((metric) => dueIds.includes(metric.id));
          if (due.length === 0) continue;
          await this.collectAndRecord(inst, due, false);
        } catch (error) {
          console.error(`实例 #${inst.id} 采集 tick 失败:`, error);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async collectAndRecord(instance: any, definitions: readonly MetricDefinition[], checkHealth = true): Promise<InstanceCollectionResult> {
    const existing = this.instanceCollections.get(instance.id);
    if (existing) return existing;

    const collection = (async () => {
      const metricIds = definitions.map((metric) => metric.id);
      const results = await this.collectInstanceMetrics(instance, metricIds, checkHealth);
      const collectedAt = Date.now();
      const status = this.schedule.get(instance.id) ?? { lastSuccessByMetric: new Map<string, number>() };
      this.schedule.set(instance.id, status);
      for (const metric of definitions) {
        const succeeded = Boolean(results[metric.id]);
        await this.scheduleStore.record('instance', instance.id, 'unified', metric, collectedAt, succeeded);
        if (succeeded) status.lastSuccessByMetric.set(metric.id, collectedAt);
      }
      return {
        instanceId: instance.id,
        attemptedMetricIds: metricIds,
        succeededMetricIds: metricIds.filter((metricId) => Boolean(results[metricId])),
        collectedAt: new Date(collectedAt).toISOString(),
      };
    })();

    this.instanceCollections.set(instance.id, collection);
    try {
      return await collection;
    } finally {
      if (this.instanceCollections.get(instance.id) === collection) {
        this.instanceCollections.delete(instance.id);
      }
    }
  }

  /**
   * 采集单个实例的指标
   */
  private async collectInstanceMetrics(instance: any, dueMetricIds: readonly string[], checkHealth = true): Promise<Record<string, boolean>> {
    // A pending-credentials instance has no meaningful health observation.
    // Guard before invoking checkHealth, which represents a missing connection
    // as a synthetic critical result.
    if (!(await this.hasUsableCredentials(instance))) {
      collectionCapabilityTracker.clearInstance(instance.id);
      for (const metricId of dueMetricIds) {
        collectionCapabilityTracker.recordMetricAttempt(instance.id, metricId, false);
      }
      await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'unknown');
      return Object.fromEntries(dueMetricIds.map((metricId) => [metricId, false]));
    }

    try {
      // Agent tools can create an active instance before its credential exists.
      // Retry from persisted configuration so adding the credential later is
      // enough to make the instance collectible without restarting the API.
      if (!databaseService.getConnection(instance.id)) {
        const reconnected = await this.tryReconnect(instance);
        if (!reconnected) {
          for (const metricId of dueMetricIds) {
            collectionCapabilityTracker.recordMetricAttempt(instance.id, metricId, false);
          }
          if (await this.hasUsableCredentials(instance)) {
            await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
          } else {
            collectionCapabilityTracker.clearInstance(instance.id);
            await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'unknown');
          }
          return Object.fromEntries(dueMetricIds.map((metricId) => [metricId, false]));
        }
      }

      const results = dueMetricIds.length > 0 ? await unifiedCollector.collectInstance(instance, dueMetricIds) : {};
      for (const metricId of dueMetricIds) {
        collectionCapabilityTracker.recordMetricAttempt(instance.id, metricId, Boolean(results[metricId]));
      }
      if (checkHealth) await this.updateHealthStatusFromCheck(instance.id);
      return results;
    } catch (error) {
      console.error(`采集实例 ${instance.name} 指标失败:`, error);
      // 记录采集失败
      for (const metricId of dueMetricIds) {
        collectionCapabilityTracker.recordMetricAttempt(instance.id, metricId, false);
      }
      // 异常路径：尝试主动重连恢复
      let recoverySucceeded = false;
      try {
        const alive = await databaseService.checkConnectionAlive(instance.id);
        if (!alive) {
          console.log(`⚠️ [${instance.name}] 采集异常 + 连接不可用，尝试重连...`);
          const reconnected = await this.tryReconnect(instance);
          if (reconnected) {
            console.log(`✅ [${instance.name}] 异常后重连成功，更新健康状态`);
            const healthCheckRecovery = await databaseService.checkHealth(instance.id);
            if (healthCheckRecovery) {
              await instanceDatabaseService.updateHealthStatus(instance.id, healthCheckRecovery.health_score, healthCheckRecovery.status);
            } else {
              await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
            }
            recoverySucceeded = true;
          }
        } else {
          // 连接还活着，采集失败不是连接问题，不标记 critical
          recoverySucceeded = true;
        }
      } catch (recoveryError) {
        console.error(`❌ [${instance.name}] 恢复尝试失败:`, recoveryError);
      }
      // 仅在重连失败时才标记 critical
      // Credentials may be removed or become undecryptable while collection
      // and recovery are in flight. Missing credentials are unknown, not a
      // database outage; re-check before persisting the terminal state.
      const credentialsAvailable = await this.hasUsableCredentials(instance);
      if (!credentialsAvailable) {
        collectionCapabilityTracker.clearInstance(instance.id);
        await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'unknown');
      } else if (!recoverySucceeded) {
        await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
      }
      return Object.fromEntries(dueMetricIds.map((metricId) => [metricId, false]));
    }
  }

  private async hasUsableCredentials(instance: any): Promise<boolean> {
    if (!instance || typeof instance.id !== 'number') return false;
    if (typeof instance.username !== 'string' || instance.username.trim().length === 0) return false;

    try {
      const password = await instanceDatabaseService.getInstancePassword(instance.id);
      return typeof password === 'string' && password.trim().length > 0;
    } catch (error) {
      console.error(`读取实例 ${instance.id} 凭据失败:`, error);
      return false;
    }
  }

  /**
   * 尝试重建实例连接 — 先走标准 reconnect，失败时用实例配置从头建连
   */
  private async tryReconnect(instance: any): Promise<boolean> {
    // 先尝试标准 reconnect（适用于连接 entry 存在但已断开的情况）
    let reconnected = await databaseService.reconnect(instance.id);
    if (reconnected) return true;

    // 标准 reconnect 失败（可能连接 entry 不存在），用实例配置从头建连
    const password = await instanceDatabaseService.getInstancePassword(instance.id);
    if (typeof password !== 'string' || password.trim().length === 0) {
      console.error(`[${instance.name}] 无法获取解密密码，无法从零建连`);
      return false;
    }

    const config = {
      host: instance.host,
      port: instance.port,
      user: instance.username,
      password,
      database: instance.database_name || undefined,
      db_type: instance.db_type,
    };

    return databaseService.reconnect(instance.id, instance.name, config);
  }

  // ================== Health Status ==================

  private async updateHealthStatusFromCheck(instanceId: number) {
    try {
      const health = await databaseService.checkHealth(instanceId);
      if (health) {
        let healthStatus: 'healthy' | 'warning' | 'critical' | 'unknown' = 'unknown';
        if (health.status === 'healthy') healthStatus = 'healthy';
        else if (health.status === 'warning') healthStatus = 'warning';
        else if (health.status === 'critical') healthStatus = 'critical';

        await instanceDatabaseService.updateHealthStatus(instanceId, health.health_score, healthStatus, health.db_version, health.data_size_gb);

        if (health.checks) {
          const issues = health.checks
            .filter((c: any) => c.status !== 'ok')
            .map((c: any) => ({
              level: c.status === 'critical' ? 'high' : 'medium',
              title: `${c.name}: ${c.message || '异常'}`,
              suggestion: c.status === 'critical' ? '立即处理' : '建议关注',
            }));
          await instanceDatabaseService.recordHealthCheck(
            instanceId, health.health_score,
            health.status,
            health.checks, issues,
            health.dimensions
          );
        }
      } else {
        console.log(`⚠️ 实例 ${instanceId} 未连接，标记为 critical`);
        await instanceDatabaseService.updateHealthStatus(instanceId, 0, 'critical');
      }
    } catch (error) {
      console.error(`更新实例 ${instanceId} 健康状态失败:`, error);
      await instanceDatabaseService.updateHealthStatus(instanceId, 0, 'critical');
    }
  }


  // ================== Slow Queries / Capacity ==================

  private async collectSlowQueries() {
    try {
      const instances = await instanceDatabaseService.getAllInstances();
      if (instances.length === 0) return;
      for (const instance of instances) {
        try {
          const slowQueries = await databaseService.getSlowQueries(instance.id);
          if (slowQueries && slowQueries.length > 0) {
            for (const query of slowQueries) {
              const sqlHash = crypto.createHash('md5').update(query.sql_text).digest('hex');
              await metricsDatabaseService.recordSlowQuery({
                instance_id: instance.id,
                sql_text: query.sql_text,
                sql_hash: sqlHash,
                avg_time_ms: query.avg_time_ms,
                max_time_ms: query.max_time_ms,
                min_time_ms: query.avg_time_ms,
                execution_count: query.execution_count,
                total_time_ms: query.avg_time_ms * query.execution_count,
              });
            }
            console.log(`📊 [${instance.name}] 采集 ${slowQueries.length} 条慢查询`);
          }
        } catch (error) {
          console.error(`采集实例 ${instance.name} 慢查询失败:`, error);
        }
      }
    } catch (error) {
      console.error('慢查询采集失败:', error);
    }
  }

  private async collectCapacity() {
    try {
      const instances = await instanceDatabaseService.getAllInstances();
      for (const inst of instances) {
        if (inst.status !== 'active') continue;
        try {
          const capacity = await databaseService.getCapacityInfo(inst.id);
          if (capacity && capacity.total_size_gb !== undefined) {
            const totalTableCount = capacity.databases
              ? capacity.databases.reduce((sum: number, db: any) => sum + (db.table_count || 0), 0)
              : 0;
            await metricsDatabaseService.recordCapacity({
              instance_id: inst.id,
              total_size_gb: capacity.total_size_gb,
              db_count: capacity.databases?.length || 0,
              table_count: totalTableCount,
              databases: capacity.databases || [],
              tablespaces: capacity.tablespaces || [],
              top_tables: capacity.top_tables || [],
              recorded_at: new Date(),
            } as any);
          }
        } catch (error) {
          console.error(`采集实例 ${inst.name} 容量失败:`, error);
        }
      }
    } catch (error) {
      console.error('容量采集失败:', error);
    }
  }

  async collectCapacityNow(): Promise<void> { await this.collectCapacity(); }
}

// 单例
export const monitorCollector = new MonitorCollector();
