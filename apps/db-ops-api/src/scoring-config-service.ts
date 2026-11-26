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
const WEIGHT_SUM_TOLERANCE = 0.01;

class ScoringConfigService {
  /**
   * 获取数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private async readStoredWeights(pool: mysql.Pool): Promise<unknown> {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT config_key, config_value FROM system_config WHERE config_key = ?',
      [CONFIG_KEY],
    );
    if (!rows.length) return undefined;
    const raw = rows[0].config_value;
    return typeof raw === 'string' && raw ? JSON.parse(raw) : raw ?? null;
  }

  /** The settings editor must not offer synthesized weights after a failed read. */
  async getConfiguredWeights(): Promise<Record<string, number>> {
    const pool = this.getPool();
    if (!pool) throw new Error('SCORING_STORAGE_UNAVAILABLE');
    const stored = await this.readStoredWeights(pool);
    if (stored === undefined) return { ...DEFAULT_WEIGHTS };
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('SCORING_WEIGHTS_INVALID');

    const values = stored as Record<string, unknown>;
    const weights: Record<string, number> = {};
    let sum = 0;
    for (const dimension of VALID_DIMENSIONS) {
      const value = values[dimension];
      if (!Object.hasOwn(values, dimension) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('SCORING_WEIGHTS_INVALID');
      }
      weights[dimension] = value;
      sum += value;
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) throw new Error('SCORING_WEIGHTS_INVALID');
    return weights;
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
      const stored = await this.readStoredWeights(pool);
      return { ...DEFAULT_WEIGHTS, ...stored as Record<string, number> | undefined };
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
    weights: unknown,
  ): Promise<{ success: boolean; error?: string; statusCode?: 400 | 500 }> {
    if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
      return { success: false, error: '评分权重必须是对象' };
    }
    const values = weights as Record<string, unknown>;
    // 验证所有维度存在
    for (const dim of VALID_DIMENSIONS) {
      if (!Object.hasOwn(values, dim) || values[dim] === undefined || values[dim] === null) {
        return { success: false, error: `缺少维度: ${dim}` };
      }
    }

    // 验证每个值在 0.0-1.0 范围内
    for (const dim of VALID_DIMENSIONS) {
      const val = values[dim];
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
    const sum = VALID_DIMENSIONS.reduce((s, dim) => s + (values[dim] as number), 0);
    if (Math.abs(sum - 1.0) > WEIGHT_SUM_TOLERANCE) {
      return {
        success: false,
        error: `所有权重之和必须约等于 1.0（当前之和: ${sum.toFixed(4)}）`,
      };
    }

    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接', statusCode: 500 };
    }

    try {
      await pool.execute(
        // 此接口不写操作者：保留已有 updated_by，新记录使用表默认值 NULL。
        // 仅更新值和类型，保留 id、description 等已有元数据。
        `INSERT INTO system_config (config_key, config_value, value_type) VALUES (?, ?, 'json')
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), value_type = 'json'`,
        [CONFIG_KEY, JSON.stringify(weights)],
      );
      return { success: true };
    } catch (error: any) {
      console.error('保存评分权重失败:', error);
      return { success: false, error: '保存评分权重失败', statusCode: 500 };
    }
  }
}

// 单例
export const scoringConfigService = new ScoringConfigService();
