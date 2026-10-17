import { semanticBaselineService } from './metrics/consumers/baseline.js';
import { assertWorkflowActive } from './workflows/execution-context.js';
/**
 * 基线计算服务 - 使用历史指标数据计算统计基线
 *
 * 基于 mean +/- 2sigma 原则计算指标基线，
 * 仅使用当前配置版本已接受的正式观测，不继承历史缓存。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';
import { instanceDatabaseService } from './instance-database-service';
import { metricRegistry } from './metric-registry';

/**
 * 基线计算结果
 */
export interface BaselineResult {
  instanceId: number;
  metricName: string;
  mean: number;
  stddev: number;
  lowerBound: number;
  upperBound: number;
  sampleCount: number;
  computedAt: Date;
}

/**
 * 基线计算器类
 *
 * 使用正式样本计算总体标准差，保留指标版本和单位。
 */
class BaselineCalculator {
  /**
   * 获取数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 计算指定实例和指标的基线
   *
   * @param instanceId 实例 ID
   * @param metricName 指标名称
   * @param sigma 标准差倍数，默认 2
   * @param lookbackDays 回溯天数，默认 7
   * @returns 计算结果
   */
  async computeBaselineForMetric(
    instanceId: number,
    metricName: string,
    sigma: number = 2,
    lookbackDays: number = 7
  ): Promise<{ success: boolean; result?: BaselineResult; error?: string }> {
    return semanticBaselineService.compute(instanceId,metricName,sigma,lookbackDays);
  }

  /**
   * 计算所有实例和所有已注册指标的基线
   *
   * @param sigma 标准差倍数，默认 2
   * @param lookbackDays 回溯天数，默认 7
   * @returns 成功/失败统计
   */
  async computeAllBaselines(
    sigma: number = 2,
    lookbackDays: number = 7
  ): Promise<{ success: number; failed: number; results: BaselineResult[] }> {
    const instances = await instanceDatabaseService.getAllInstances();
    const metricIds = metricRegistry.getMetricIds();

    let successCount = 0;
    let failedCount = 0;
    const results: BaselineResult[] = [];

    for (const instance of instances) {
      for (const metricId of metricIds) {
        const result = await this.computeBaselineForMetric(
          instance.id,
          metricId,
          sigma,
          lookbackDays
        );

        if (result.success && result.result) {
          successCount++;
          results.push(result.result);
        } else {
          failedCount++;
        }
      }
    }

    return { success: successCount, failed: failedCount, results };
  }

  /**
   * 获取当前配置版本的正式指标基线缓存
   *
   * @param instanceId 实例 ID
   * @param metricName 指标名称
   * @returns 缓存基线或 null
   */
  async getCachedBaseline(
    instanceId: number,
    metricName: string
  ): Promise<{ mean: number; stddev: number; lowerBound: number; upperBound: number } | null> {
    return semanticBaselineService.cached(instanceId,metricName);
  }

  /**
   * 删除过期的基线记录
   *
   * @param retentionDays 保留天数，默认 30
   */
  async cleanupOldBaselines(retentionDays: number = 30): Promise<{ success: boolean; deleted?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: 'DATABASE_UNAVAILABLE' };
    }

    try {
      assertWorkflowActive();
      const [result] = await pool.execute(
        `DELETE FROM metric_semantic_baselines WHERE computed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [retentionDays]
      );
      return { success: true, deleted: Number((result as { affectedRows: number }).affectedRows) };
    } catch (error) {
      assertWorkflowActive();
      console.error('清理过期基线失败:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// 单例导出
export const baselineCalculator = new BaselineCalculator();
