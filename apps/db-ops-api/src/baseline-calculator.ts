/**
 * 基线计算服务 - 使用历史指标数据计算统计基线
 *
 * 基于 mean +/- 2sigma 原则计算指标基线，
 * 支持 SQL 计算和 in-memory fallback（simple-statistics）。
 */
import mysql from 'mysql2/promise';
import * as ss from 'simple-statistics';
import { dbConnection } from './db-connection';
import { metricsDatabaseService } from './metrics-database-service';
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
 * 使用 SQL STDDEV_POP 进行高效计算，
 * 当 stddev 为 NULL 时使用 simple-statistics 作为 in-memory fallback。
 */
class BaselineCalculator {
  private readonly MIN_SAMPLE_SIZE = 10;

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
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    // Whitelist validation to prevent SQL injection via metricName
    const validMetricIds = metricRegistry.getMetricIds();
    if (!validMetricIds.includes(metricName)) {
      return { success: false, error: `Invalid metric name: ${metricName}` };
    }

    try {
      // 使用 SQL STDDEV_POP 计算均值和标准差
      const [rows] = await pool.execute(
        `SELECT
          instance_id,
          AVG(\`${metricName}\`) AS mean_val,
          STDDEV_POP(\`${metricName}\`) AS stddev_val,
          COUNT(*) AS sample_count
         FROM metrics_history
         WHERE instance_id = ?
           AND recorded_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY instance_id
         HAVING COUNT(*) >= ?`,
        [instanceId, lookbackDays, this.MIN_SAMPLE_SIZE]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return {
          success: false,
          error: `样本量不足（< ${this.MIN_SAMPLE_SIZE}）或无历史数据`,
        };
      }

      const row = rows[0];
      let meanVal = Number(row.mean_val);
      let stddevVal = row.stddev_val !== null && row.stddev_val !== undefined ? Number(row.stddev_val) : null;

      // 如果 stddev 为 NULL（单一样本），使用 in-memory fallback
      if (stddevVal === null || isNaN(stddevVal)) {
        const fallbackResult = await this._computeInMemory(instanceId, metricName, lookbackDays);
        if (!fallbackResult.success) {
          return fallbackResult;
        }
        meanVal = fallbackResult.result!.mean;
        stddevVal = fallbackResult.result!.stddev;
      }

      // 计算上下界
      let lowerBound = meanVal - sigma * stddevVal;
      const upperBound = meanVal + sigma * stddevVal;

      // 对永远为正的指标（CPU、内存等），lowerBound 不小于 0
      if (metricName === 'cpu_usage' || metricName === 'memory_usage' || metricName === 'disk_usage') {
        lowerBound = Math.max(0, lowerBound);
      }

      const result: BaselineResult = {
        instanceId,
        metricName,
        mean: Number(meanVal.toFixed(4)),
        stddev: Number(stddevVal.toFixed(4)),
        lowerBound: Number(lowerBound.toFixed(4)),
        upperBound: Number(upperBound.toFixed(4)),
        sampleCount: Number(row.sample_count),
        computedAt: new Date(),
      };

      // UPSERT 到 metric_baselines 表
      await this._saveBaseline(result, sigma, lookbackDays);

      return { success: true, result };
    } catch (error: any) {
      console.error(`计算基线失败 [${metricName} 实例 ${instanceId}]:`, error);
      return { success: false, error: error.message };
    }
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
   * 从 metric_baselines 表获取缓存的基线
   *
   * @param instanceId 实例 ID
   * @param metricName 指标名称
   * @returns 缓存基线或 null
   */
  async getCachedBaseline(
    instanceId: number,
    metricName: string
  ): Promise<{ mean: number; stddev: number; lowerBound: number; upperBound: number } | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT mean_val, stddev_val, lower_bound, upper_bound
         FROM metric_baselines
         WHERE instance_id = ? AND metric_name = ?
         ORDER BY computed_at DESC
         LIMIT 1`,
        [instanceId, metricName]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        mean: Number(row.mean_val),
        stddev: Number(row.stddev_val),
        lowerBound: Number(row.lower_bound),
        upperBound: Number(row.upper_bound),
      };
    } catch (error) {
      console.error(`获取缓存基线失败 [${metricName} 实例 ${instanceId}]:`, error);
      return null;
    }
  }

  /**
   * 删除过期的基线记录
   *
   * @param retentionDays 保留天数，默认 30
   */
  async cleanupOldBaselines(retentionDays: number = 30): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      await pool.execute(
        `DELETE FROM metric_baselines WHERE computed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [retentionDays]
      );
    } catch (error) {
      console.error('清理过期基线失败:', error);
    }
  }

  /**
   * 从内存中计算基线（in-memory fallback）
   *
   * 当 SQL STDDEV_POP 返回 NULL 时使用 simple-statistics 计算。
   */
  private async _computeInMemory(
    instanceId: number,
    metricName: string,
    lookbackDays: number
  ): Promise<{ success: boolean; result?: BaselineResult; error?: string }> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const historicalData = await metricsDatabaseService.getHistoricalMetrics(
      instanceId,
      startTime,
      endTime
    );

    if (historicalData.length < this.MIN_SAMPLE_SIZE) {
      return {
        success: false,
        error: `样本量不足（< ${this.MIN_SAMPLE_SIZE}）`,
      };
    }

    // 提取指标值
    const values = historicalData
      .map((r: any) => Number((r as any)[metricName]))
      .filter((v: number) => !isNaN(v));

    if (values.length < this.MIN_SAMPLE_SIZE) {
      return {
        success: false,
        error: `有效样本量不足（< ${this.MIN_SAMPLE_SIZE}）`,
      };
    }

    const mean = ss.mean(values);
    const stddev = ss.standardDeviation(values);

    return {
      success: true,
      result: {
        instanceId,
        metricName,
        mean,
        stddev,
        lowerBound: mean - 2 * stddev,
        upperBound: mean + 2 * stddev,
        sampleCount: values.length,
        computedAt: new Date(),
      },
    };
  }

  /**
   * 将基线结果 UPSERT 到 metric_baselines 表
   */
  private async _saveBaseline(
    result: BaselineResult,
    sigma: number,
    lookbackDays: number
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    await pool.execute(
      `INSERT INTO metric_baselines
       (instance_id, metric_name, mean_val, stddev_val, lower_bound, upper_bound, sigma, lookback_days, sample_count, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         mean_val = VALUES(mean_val),
         stddev_val = VALUES(stddev_val),
         lower_bound = VALUES(lower_bound),
         upper_bound = VALUES(upper_bound),
         sigma = VALUES(sigma),
         lookback_days = VALUES(lookback_days),
         sample_count = VALUES(sample_count),
         computed_at = VALUES(computed_at)`,
      [
        result.instanceId,
        result.metricName,
        result.mean,
        result.stddev,
        result.lowerBound,
        result.upperBound,
        sigma,
        lookbackDays,
        result.sampleCount,
        result.computedAt,
      ]
    );
  }
}

// 单例导出
export const baselineCalculator = new BaselineCalculator();
