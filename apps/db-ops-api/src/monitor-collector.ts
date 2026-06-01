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

interface InstanceSchedule {
  lastCollected: number;
  intervalMs: number;  // 该实例最短的指标间隔
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

class MonitorCollector {
  private schedule: Map<number, InstanceSchedule> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private slowQueryTimer: ReturnType<typeof setInterval> | null = null;
  private capacityTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
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

    this.running = true;
    console.log('✅ 监控采集已启动（Zabbix 心跳模型）');
    console.log(`   - 心跳: 每 ${this.config.heartbeatMs / 1000}s`);
    console.log('   - 慢查询: 每 5 分钟');
    console.log('   - 容量: 每 1 小时');
    for (const [id, s] of this.schedule) {
      console.log(`   - 实例 #${id}: 每 ${s.intervalMs / 1000}s`);
    }
  }

  /**
   * 停止监控采集
   */
  stop() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.slowQueryTimer) { clearInterval(this.slowQueryTimer); this.slowQueryTimer = null; }
    if (this.capacityTimer) { clearInterval(this.capacityTimer); this.capacityTimer = null; }
    this.schedule.clear();
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
        intervalMs: s.intervalMs,
        lastCollected: new Date(s.lastCollected).toISOString(),
        nextCollect: new Date(s.lastCollected + s.intervalMs).toISOString(),
      })),
    };
  }

  /**
   * 重建采集计划 —— registry 变更后调用
   */
  refreshSchedule() {
    this._rebuildSchedule().catch(e => console.error('刷新采集计划失败:', e));
  }

  // ================== private ==================

  /**
   * 从 metric-registry 重建每个实例的采集间隔
   * 取该实例支持的所有指标中最小 default_interval
   */
  private async _rebuildSchedule() {
    const metrics = metricRegistry.getAll().filter(m => m.is_collected);
    const minIntervalMs = metrics.length > 0
      ? Math.max(15000, Math.min(...metrics.map(m => (m.default_interval ?? 30) * 1000)))
      : 60000;
    // Rebuild schedule from scratch to prevent stale instance leaks
    const newSchedule = new Map<number, InstanceSchedule>();
    const instances = await instanceDatabaseService.getAllInstances();
    for (const inst of instances) {
      if (inst.status !== 'active') continue;
      const existing = this.schedule.get(inst.id);
      newSchedule.set(inst.id, existing ?? { lastCollected: 0, intervalMs: minIntervalMs });
    }
    this.schedule = newSchedule;
  }

  /**
   * 心跳：检查哪些实例到期，采集它们
   */
  private async _tick() {
    const now = Date.now();
    const instances = await instanceDatabaseService.getAllInstances();
    if (instances.length === 0) return;

    const metrics = metricRegistry.getAll().filter(m => m.is_collected);
    const minInterval = metrics.length > 0
      ? Math.max(15000, Math.min(...metrics.map(m => (m.default_interval ?? 30) * 1000)))
      : 60000;

    for (const inst of instances) {
      if (inst.status !== 'active') continue;

      let sched = this.schedule.get(inst.id);
      // 首次遇到该实例：用最小间隔初始化
      if (!sched) {
        sched = { lastCollected: 0, intervalMs: minInterval };
        this.schedule.set(inst.id, sched);
      }

      if (now >= sched.lastCollected + sched.intervalMs) {
        await this.collectInstanceMetrics(inst);
        this.schedule.set(inst.id, {
          lastCollected: Date.now(),
          intervalMs: sched.intervalMs,
        });
      }
    }
  }

  /**
   * 采集单个实例的指标
   */
  private async collectInstanceMetrics(instance: any) {
    try {
      // 通过 UnifiedCollector 调度 Provider 架构采集指标
      await unifiedCollector.collectInstance(instance);
      // 仍通过 getRealtimeMetrics 获取最新完整指标用于日志和向后兼容
      const metrics = await databaseService.getRealtimeMetrics(instance.id);
      if (metrics) {
        console.log(`📊 [${instance.name}] CPU: ${metrics.cpu_usage}%, Memory: ${metrics.memory_usage}%, Connections: ${metrics.connections}`);
      } else {
        // getRealtimeMetrics 返回 null —— 连接不可用或重连失败
        // 尝试主动重连
        console.log(`⚠️ [${instance.name}] 指标采集返回 null，尝试主动重连...`);
        // 记录采集失败
        const expectedMetrics = metricRegistry.getAll()
          .filter((m: any) => m.is_collected && m.db_types.includes(instance.db_type));
        for (const m of expectedMetrics) {
          collectionCapabilityTracker.recordMetricAttempt(instance.id, m.name, false);
        }
        const reconnected = await this.tryReconnect(instance);
        if (reconnected) {
          console.log(`✅ [${instance.name}] 主动重连成功，更新健康状态`);
          // 重连后立即标记为 healthy（不等待下一个 tick）
          const healthCheck = await databaseService.checkHealth(instance.id);
          if (healthCheck) {
            await instanceDatabaseService.updateHealthStatus(instance.id, healthCheck.health_score, healthCheck.status);
          } else {
            await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
          }
          // 尝试重新采集一次
          const retryMetrics = await databaseService.getRealtimeMetrics(instance.id);
          if (retryMetrics) {
            await metricsDatabaseService.recordMetrics({
              ...retryMetrics,
              instance_id: instance.id,
            });
            console.log(`📊 [${instance.name}] 重连后采集成功：CPU: ${retryMetrics.cpu_usage}%`);
          }
        } else {
          console.error(`❌ [${instance.name}] 主动重连失败`);
        }
      }
      // 无论 metrics 是否成功，都执行健康状态检查
      await this.updateHealthStatusFromCheck(instance.id);
    } catch (error) {
      console.error(`采集实例 ${instance.name} 指标失败:`, error);
      // 记录采集失败
      const expectedMetrics = metricRegistry.getAll()
        .filter((m: any) => m.is_collected && m.db_types.includes(instance.db_type));
      for (const m of expectedMetrics) {
        collectionCapabilityTracker.recordMetricAttempt(instance.id, m.name, false);
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
      if (!recoverySucceeded) {
        await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
      }
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
    if (!password) {
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
            health.status as 'healthy' | 'warning' | 'critical',
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
}

// 单例
export const monitorCollector = new MonitorCollector();
