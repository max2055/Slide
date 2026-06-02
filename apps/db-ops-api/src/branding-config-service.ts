/**
 * 品牌配置服务
 *
 * 管理 branding.config 在 system_config 表中的读写。
 * 遵循 scoring-config-service.ts 和 ai-analysis-config-service.ts 的模式（CRUD + 验证 + 默认值合并）。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';

export interface BrandingConfig {
  cli_name: string;
  product_name: string;
  env_prefix: string;
  state_dir: string;
}

/**
 * 默认值 — 与 frontend/src/app/src/branding.ts 保持一致
 */
export const DEFAULTS: BrandingConfig = {
  cli_name: 'slide',
  product_name: 'Slide',
  env_prefix: 'SLIDE',
  state_dir: '.slide',
};

const CONFIG_KEY = 'branding.config';

const CLI_NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const ENV_PREFIX_REGEX = /^[A-Z][A-Z0-9_]*$/;

class BrandingConfigService {
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
   * 获取当前品牌配置
   *
   * 从 system_config 读取，与 DEFAULTS 合并。
   * 存储值覆盖默认值，默认值填充缺失键。
   *
   * @returns 品牌配置 { cli_name, product_name, env_prefix, state_dir }
   */
  async getBranding(): Promise<BrandingConfig> {
    const pool = this.getPool();
    if (!pool) {
      return { ...DEFAULTS };
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
          return { ...DEFAULTS, ...parsed };
        }
      }

      return { ...DEFAULTS };
    } catch (error) {
      console.error('获取品牌配置失败:', error);
      return { ...DEFAULTS };
    }
  }

  /**
   * 保存品牌配置
   *
   * 验证规则:
   * - 所有 4 个字段必须是非空 string
   * - cli_name 只允许 [a-z][a-z0-9-]*
   * - env_prefix 只允许 [A-Z][A-Z0-9_]*
   *
   * @param config - 待保存的品牌配置（部分更新）
   * @returns 保存结果
   */
  async saveBranding(
    config: Partial<BrandingConfig>,
  ): Promise<{ success: boolean; error?: string }> {
    const fields: (keyof BrandingConfig)[] = [
      'cli_name',
      'product_name',
      'env_prefix',
      'state_dir',
    ];

    // 至少提供一个字段
    const hasAnyField = fields.some(f => config[f] !== undefined && config[f] !== null);
    if (!hasAnyField) {
      return { success: false, error: '至少需要提供一个配置字段' };
    }

    // 验证每个提供的字段
    for (const field of fields) {
      const val = config[field];
      if (val === undefined || val === null) {
        continue; // 未提供的字段跳过验证
      }

      if (typeof val !== 'string') {
        return { success: false, error: `${field} 必须是字符串` };
      }

      if (val.trim().length === 0) {
        return { success: false, error: `${field} 不能为空` };
      }

      if (field === 'cli_name' && !CLI_NAME_REGEX.test(val)) {
        return {
          success: false,
          error: `cli_name 只允许小写字母开头，包含小写字母、数字和连字符（当前值: ${val}）`,
        };
      }

      if (field === 'env_prefix' && !ENV_PREFIX_REGEX.test(val)) {
        return {
          success: false,
          error: `env_prefix 只允许大写字母开头，包含大写字母、数字和下划线（当前值: ${val}）`,
        };
      }
    }

    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 读取当前值，合并后再写入（部分更新支持）
      const current = await this.getBranding();
      const merged = { ...current, ...config };

      await pool.execute(
        `REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)`,
        [CONFIG_KEY, JSON.stringify(merged)],
      );
      return { success: true };
    } catch (error: any) {
      console.error('保存品牌配置失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const brandingConfigService = new BrandingConfigService();
