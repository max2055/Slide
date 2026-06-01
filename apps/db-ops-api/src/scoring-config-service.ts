/**
 * 评分权重配置服务
 *
 * 管理 scoring.weights 在 system_config 表中的读写。
 * 遵循 ai-analysis-config-service.ts 的模式（CRUD + 验证 + 默认值合并）。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';

export const DEFAULT_WEIGHTS: Record<string, number> = {
  availability: 0.35,
  performance: 0.35,
  capacity: 0.20,
  security: 0.10,
};

const CONFIG_KEY = 'scoring.weights';

const VALID_DIMENSIONS = ['availability', 'performance', 'capacity', 'security'];

class ScoringConfigService {
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
   * 获取当前评分权重
   *
   * 从 system_config 读取，与 DEFAULT_WEIGHTS 合并。
   * 存储值覆盖默认值，默认值填充缺失键。
   *
   * @returns 权重映射 { availability, performance, capacity, security }
   */
  async getWeights(): Promise<Record<string, number>> {
    const pool = this.getPool();
    if (!pool) {
      return { ...DEFAULT_WEIGHTS };
    }

    try {
      const [rows] = await pool.execute(
        `SELECT config_key, config_value FROM system_config WHERE config_key = ?`,
        [CONFIG_KEY],
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const configValue = rows[0].config_value;
        if (configValue) {
          const parsed = typeof configValue === 'string'
            ? JSON.parse(configValue)
            : configValue;
          return { ...DEFAULT_WEIGHTS, ...parsed };
        }
      }

      return { ...DEFAULT_WEIGHTS };
    } catch (error) {
      console.error('获取评分权重失败:', error);
      return { ...DEFAULT_WEIGHTS };
    }
  }

  /**
   * 保存评分权重
   *
   * 验证规则:
   * - 每个值必须是 0.0-1.0 之间的数字
   * - 所有权重之和必须在 ±0.01 的容忍度内为 1.0
   *
   * @param weights - 待保存的权重
   * @returns 保存结果
   */
  async saveWeights(
    weights: Record<string, number>,
  ): Promise<{ success: boolean; error?: string }> {
    // 验证所有维度存在
    for (const dim of VALID_DIMENSIONS) {
      if (weights[dim] === undefined || weights[dim] === null) {
        return { success: false, error: `缺少维度: ${dim}` };
      }
    }

    // 验证每个值在 0.0-1.0 范围内
    for (const dim of VALID_DIMENSIONS) {
      const val = weights[dim];
      if (typeof val !== 'number' || isNaN(val)) {
        return { success: false, error: `${dim} 必须是数字` };
      }
      if (val < 0 || val > 1) {
        return {
          success: false,
          error: `${dim} 必须在 0.0 到 1.0 之间（当前值: ${val}）`,
        };
      }
    }

    // 验证权值之和 ≈ 1.0
    const sum = VALID_DIMENSIONS.reduce((s, dim) => s + weights[dim], 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      return {
        success: false,
        error: `所有权重之和必须约等于 1.0（当前之和: ${sum.toFixed(4)}）`,
      };
    }

    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)`,
        [CONFIG_KEY, JSON.stringify(weights)],
      );
      return { success: true };
    } catch (error: any) {
      console.error('保存评分权重失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const scoringConfigService = new ScoringConfigService();
