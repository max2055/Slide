/**
 * 采集能力追踪器
 *
 * 内存级记录每个实例每指标的采集成功/失败状态。
 * 用于前端展示哪些采集能力正常工作（绿色），哪些异常（红色）或尚未尝试（灰色）。
 *
 * 设计:
 * - 无界 Map 由 monitor-collector 的采集循环驱动
 * - metric_definitions 中的 expected 指标与实际的尝试状态合并
 */
import { metricRegistry } from './metric-registry.js';

export interface MetricCapability {
  metricId: string;
  name: string;
  available: boolean;
  lastAttempt?: string;
}

interface AttemptRecord {
  available: boolean;
  lastAttempt: number;
  lastSuccess: number;
}

class CollectionCapabilityTracker {
  /**
   * instanceId → (metricId → AttemptRecord)
   */
  private store: Map<number, Map<string, AttemptRecord>> = new Map();

  /**
   * 记录一次指标采集尝试
   *
   * @param instanceId - 实例 ID
   * @param metricName - 指标名称（metric_registry 中的 name 字段）
   * @param success - 采集是否成功
   */
  recordMetricAttempt(instanceId: number, metricName: string, success: boolean): void {
    let instanceMap = this.store.get(instanceId);
    if (!instanceMap) {
      instanceMap = new Map();
      this.store.set(instanceId, instanceMap);
    }

    const now = Date.now();
    const existing = instanceMap.get(metricName);

    const record: AttemptRecord = {
      available: success,
      lastAttempt: now,
      lastSuccess: success
        ? now
        : (existing?.lastSuccess || 0),
    };

    // 如果之前成功过，不要因为一次失败就覆盖 available——除非从未成功过
    if (!success && existing?.lastSuccess && existing.lastSuccess > 0) {
      record.available = true;
      record.lastSuccess = existing.lastSuccess;
    }

    instanceMap.set(metricName, record);
  }

  /**
   * 获取指定实例的采集能力状态
   *
   * 将 metric_registry 中的预期指标（按 db_type 过滤）与实际采集状态合并。
   * 尚未尝试的指标: available=false（灰色）
   * 成功采集的指标: available=true（绿色）
   * 最近失败但曾有成功: available=true（绿色，但可检查 lastAttempt）
   *
   * @param instanceId - 实例 ID
   * @param dbType - 数据库类型（用于过滤指标）
   * @returns 能力状态列表
   */
  getCapabilities(instanceId: number, dbType: string): MetricCapability[] {
    const expectedMetrics = metricRegistry.getByDbType(dbType);
    const instanceMap = this.store.get(instanceId);

    return expectedMetrics.map((metric) => {
      const name = metric.name;
      const record = instanceMap?.get(name);

      return {
        metricId: metric.id,
        name,
        available: record?.available ?? false,
        lastAttempt: record?.lastAttempt
          ? new Date(record.lastAttempt).toISOString()
          : undefined,
      };
    });
  }
}

// 单例
export const collectionCapabilityTracker = new CollectionCapabilityTracker();
