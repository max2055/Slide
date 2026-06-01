/**
 * 容量预测服务
 * 基于 simple-statistics 线性回归，预测资源使用趋势
 */
import * as ss from 'simple-statistics';
import { metricsDatabaseService } from './metrics-database-service.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';

export interface PredictionPoint {
  date: string; // YYYY-MM-DD
  value: number;
  is_predicted: boolean;
}

export interface PredictionResult {
  instance_id: number;
  metric: string;
  current_value: number;
  regression: { m: number; b: number; r_squared: number };
  predictions: PredictionPoint[];
  horizon: '7d' | '30d' | '90d';
  saturation_threshold: number | null;
  warning: string | null;
  data_points_used: number;
  effective_lookback_days: number;
}

const SATURATION_THRESHOLDS: Record<string, number | null> = {
  disk_usage: 90,
  connections: null,
  cpu_usage: 90,
  memory_usage: 90,
  qps: null,
};

const VALID_METRICS = ['disk_usage', 'connections', 'cpu_usage', 'memory_usage', 'qps'];

class CapacityPredictor {
  /**
   * 预测单个指标
   */
  async predict(
    instanceId: number,
    metric: string,
    horizon: '7d' | '30d' | '90d'
  ): Promise<PredictionResult> {
    // 验证 metric
    if (!VALID_METRICS.includes(metric)) {
      throw new Error(`不支持的指标: ${metric}。支持的指标: ${VALID_METRICS.join(', ')}`);
    }

    // 计算时间范围
    const now = new Date();
    const horizonDays = horizon === '7d' ? 7 : horizon === '30d' ? 30 : 90;
    const lookbackDays = horizonDays * 2;
    const startTime = new Date(now.getTime() - lookbackDays * 86400000);

    // 获取历史数据
    const records = await metricsDatabaseService.getHistoricalMetrics(
      instanceId,
      startTime,
      now
    );

    // 最小数据点检查
    const minDataPoints: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
    const required = minDataPoints[horizon] || 7;
    let warning: string | null = null;

    if (records.length < required) {
      warning = `数据点不足（${records.length}/${required}），${horizon} 预测结果可能不可靠`;
    }

    if (records.length === 0) {
      return {
        instance_id: instanceId,
        metric,
        current_value: 0,
        regression: { m: 0, b: 0, r_squared: 0 },
        predictions: [],
        horizon,
        saturation_threshold: SATURATION_THRESHOLDS[metric] ?? null,
        warning: '无有效历史数据',
        data_points_used: 0,
        effective_lookback_days: lookbackDays,
      };
    }

    // 准备回归数据（将时间戳归一化为相对天数，避免浮点精度问题）
    const baseTime = records[0].recorded_at.getTime();
    const dataPoints: [number, number][] = records
      .map((r) => [(r.recorded_at.getTime() - baseTime) / 86400000, r[metric as keyof typeof r]] as [number, number])
      .filter((p) => !isNaN(p[0]) && !isNaN(p[1]));

    // 如果没有有效数据点
    if (dataPoints.length === 0) {
      return {
        instance_id: instanceId,
        metric,
        current_value: 0,
        regression: { m: 0, b: 0, r_squared: 0 },
        predictions: [],
        horizon,
        saturation_threshold: SATURATION_THRESHOLDS[metric] ?? null,
        warning: '无有效历史数据',
        data_points_used: 0,
        effective_lookback_days: lookbackDays,
      };
    }

    // 线性回归
    const regression = ss.linearRegression(dataPoints);
    const predictFn = ss.linearRegressionLine(regression);
    const rSquared = ss.rSquared(dataPoints, predictFn);

    // 生成预测点（使用归一化的天为单位）
    const nowDays = (now.getTime() - baseTime) / 86400000;
    const predictions: PredictionPoint[] = [];
    for (let i = 0; i < horizonDays; i++) {
      const futureDays = nowDays + (i + 1);
      const value = predictFn(futureDays);
      predictions.push({
        date: new Date(now.getTime() + (i + 1) * 86400000).toISOString().split('T')[0],
        value: Math.round(value * 100) / 100,
        is_predicted: true,
      });
    }

    // 当前值（最新记录）
    const currentValue = dataPoints[dataPoints.length - 1][1];

    // 饱和阈值
    let saturationThreshold = SATURATION_THRESHOLDS[metric] ?? null;
    if (metric === 'connections' && saturationThreshold === null) {
      // 尝试从实例配置获取 max_connections
      saturationThreshold = await this._getMaxConnections(instanceId);
    }

    // 构建预测结果
    const result: PredictionResult = {
      instance_id: instanceId,
      metric,
      current_value: Math.round(currentValue * 100) / 100,
      regression: {
        m: regression.m,
        b: regression.b,
        r_squared: Math.round(rSquared * 10000) / 10000,
      },
      predictions,
      horizon,
      saturation_threshold: saturationThreshold,
      warning,
      data_points_used: dataPoints.length,
      effective_lookback_days: lookbackDays,
    };

    // 缓存到 ai_analysis 表
    try {
      const cacheKey = `capacity:${instanceId}:${metric}:${horizon}`;
      const createResult = await aiAnalysisDatabaseService.createAnalysis({
        analysis_type: 'capacity_prediction',
        instance_id: instanceId,
        trigger_type: 'manual',
        cache_key: cacheKey,
      });

      if (createResult.success && createResult.analysisId) {
        await aiAnalysisDatabaseService.completeAnalysis(createResult.analysisId, {
          result,
        });
      }
    } catch (err) {
      console.warn('[CapacityPredictor] 缓存预测结果失败:', err);
    }

    return result;
  }

  /**
   * 预测所有指标
   */
  async predictAll(
    instanceId: number,
    horizon: '7d' | '30d' | '90d'
  ): Promise<PredictionResult[]> {
    const results: PredictionResult[] = [];

    for (const metric of VALID_METRICS) {
      try {
        const result = await this.predict(instanceId, metric, horizon);
        results.push(result);
      } catch (err: any) {
        console.error(`[CapacityPredictor] 预测 ${metric} 失败:`, err.message);
        results.push({
          instance_id: instanceId,
          metric,
          current_value: 0,
          regression: { m: 0, b: 0, r_squared: 0 },
          predictions: [],
          horizon,
          saturation_threshold: SATURATION_THRESHOLDS[metric] ?? null,
          warning: `预测失败: ${err.message}`,
          data_points_used: 0,
        });
      }
    }

    return results;
  }

  /**
   * 计算到达饱和的时间
   */
  async getTimeToSaturation(
    instanceId: number,
    metric: string,
    threshold: number
  ): Promise<{ days: number; value_at_saturation: number } | null> {
    // 先获取 90 天回归模型
    const result = await this.predict(instanceId, metric, '90d');

    const { m, b } = result.regression;

    // 斜率无效或 <= 0，指标稳定或下降，不会饱和
    if (!Number.isFinite(m) || m <= 0) {
      return null;
    }

    // threshold = m * t_days + b → t_days = (threshold - b) / m (t is in days from baseTime)
    const tDays = (threshold - b) / m;
    // Now is roughly ~lookback_days from baseTime. We approximate nowDays as 0 offset from baseTime
    // since the regression was built with baseTime = records[0].recorded_at.getTime()
    // For accuracy, we note that predict() uses lookbackDays * 2 as the data window,
    // and the regression x-values are relative to the first record.
    // A safe approach: tDays is already in days from baseTime; the latest data point
    // is at roughly lookbackDays from baseTime. So days from now = tDays - lookbackDays.
    const lookbackDays = result.effective_lookback_days; // derived from predict() internal logic
    const daysToSaturation = tDays - lookbackDays;

    if (daysToSaturation <= 0) {
      return null; // 已经超过阈值
    }

    const valueAtSaturation = predictFn(m, b, tDays);

    return {
      days: Math.round(daysToSaturation * 10) / 10,
      value_at_saturation: Math.round(valueAtSaturation * 100) / 100,
    };
  }

  /**
   * 获取实例的 max_connections
   */
  private async _getMaxConnections(instanceId: number): Promise<number | null> {
    try {
      const { dbConnection } = await import('./db-connection.js');
      const pool = dbConnection.getPool();
      if (!pool) return null;

      const [rows] = await pool.execute(
        `SELECT max_connections FROM database_instances WHERE id = ?`,
        [instanceId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0 && rows[0].max_connections) {
        return rows[0].max_connections;
      }
    } catch {
      // ignore
    }
    return null;
  }
}

/** 独立的线性回归预测函数 */
function predictFn(m: number, b: number, x: number): number {
  return m * x + b;
}

export const capacityPredictor = new CapacityPredictor();
