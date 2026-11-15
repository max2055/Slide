/**
 * 品牌配置服务
 *
 * 管理 branding.config 在 system_config 表中的读写。
 * 部分更新在单连接事务内锁定、读取并合并，读取兜底不参与写入。
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

const FIELDS = Object.keys(DEFAULTS) as (keyof BrandingConfig)[];

function validatePatch(value: unknown): Partial<BrandingConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('品牌配置必须是对象');
  }
  const patch: Partial<BrandingConfig> = {};
  for (const field of Object.keys(value)) {
    if (!FIELDS.includes(field as keyof BrandingConfig)) {
      throw new Error(`未知品牌配置字段: ${field}`);
    }
    const key = field as keyof BrandingConfig;
    const val = (value as Record<string, unknown>)[key];
    if (typeof val !== 'string') throw new Error(`${key} 必须是字符串`);
    if (!val.trim()) throw new Error(`${key} 不能为空`);
    if (key === 'cli_name' && !CLI_NAME_REGEX.test(val)) {
      throw new Error('cli_name 只允许小写字母开头，包含小写字母、数字和连字符');
    }
    if (key === 'env_prefix' && !ENV_PREFIX_REGEX.test(val)) {
      throw new Error('env_prefix 只允许大写字母开头，包含大写字母、数字和下划线');
    }
    patch[key] = val;
  }
  return patch;
}

function parseStored(value: unknown): BrandingConfig {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return { ...DEFAULTS, ...validatePatch(parsed) };
  } catch {
    throw new Error('已存品牌配置无效，请修复存储后重试');
  }
}

class BrandingConfigService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
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
        return parseStored(rows[0].config_value);
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
    let patch: Partial<BrandingConfig>;
    try {
      patch = validatePatch(config);
      if (Object.keys(patch).length === 0) {
        return { success: false, error: '至少需要提供一个配置字段' };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }

    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    let connection: mysql.PoolConnection | undefined;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      // Upsert takes the unique-key write lock even for the first concurrent save.
      // A duplicate keeps the original row and all system_config metadata.
      await connection.execute(
        `INSERT INTO system_config (config_key, config_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_key = config_key`,
        [CONFIG_KEY, JSON.stringify(DEFAULTS)],
      );
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT config_value FROM system_config WHERE config_key = ? FOR UPDATE`,
        [CONFIG_KEY],
      );
      if (rows.length !== 1) throw new Error('品牌配置读取失败');
      const current = parseStored(rows[0].config_value);
      await connection.execute(
        `UPDATE system_config SET config_value = ? WHERE config_key = ?`,
        [JSON.stringify({ ...current, ...patch }), CONFIG_KEY],
      );
      await connection.commit();
      return { success: true };
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); }
        catch (rollbackError) {
          // Never return a connection with an unresolved transaction to the pool.
          connection.destroy();
          connection = undefined;
          console.error('回滚品牌配置失败:', rollbackError);
        }
      }
      console.error('保存品牌配置失败:', error);
      return { success: false, error: (error as Error).message };
    } finally {
      connection?.release();
    }
  }
}

export const brandingConfigService = new BrandingConfigService();
