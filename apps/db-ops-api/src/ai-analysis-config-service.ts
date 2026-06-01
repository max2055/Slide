/**
 * AI 分析配置服务
 * 管理自动分析的调度配置，持久化到 system_config 表
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';

export interface AiAnalysisConfig {
  enabled: boolean;           // default: true — master toggle
  cronExpression: string;     // default: "*/30 * * * *"
  severityLevels: string[];   // default: ["critical", "error", "warning"]
  instanceWhitelist: number[]; // default: [] (empty = all instances)
  timeWindowStart: string;    // default: "00:00"
  timeWindowEnd: string;      // default: "23:59"
}

export const DEFAULT_CONFIG: AiAnalysisConfig = {
  enabled: true,
  cronExpression: '*/30 * * * *',
  severityLevels: ['critical', 'error', 'warning'],
  instanceWhitelist: [],
  timeWindowStart: '00:00',
  timeWindowEnd: '23:59',
};

const ALLOWED_SEVERITY_LEVELS = ['critical', 'error', 'warning', 'info'];
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

class AiAnalysisConfigService {
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
   * 获取自动分析配置
   * 从 system_config 表读取，不存在则返回默认配置
   */
  async getConfig(): Promise<AiAnalysisConfig> {
    const pool = this.getPool();
    if (!pool) {
      return { ...DEFAULT_CONFIG };
    }

    try {
      const [rows] = await pool.execute(
        `SELECT config_key, config_value FROM system_config WHERE config_key = ?`,
        ['auto_analysis_config']
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const configValue = rows[0].config_value;
        if (configValue) {
          const parsed = typeof configValue === 'string' ? JSON.parse(configValue) : configValue;
          return { ...DEFAULT_CONFIG, ...parsed };
        }
      }

      return { ...DEFAULT_CONFIG };
    } catch (error) {
      console.error('获取自动分析配置失败:', error);
      return { ...DEFAULT_CONFIG };
    }
  }

  /**
   * 保存自动分析配置
   * 验证字段后写入 system_config 表
   */
  async saveConfig(config: AiAnalysisConfig): Promise<{ success: boolean; error?: string }> {
    // 字段类型验证
    if (typeof config.enabled !== 'boolean') {
      return { success: false, error: 'enabled 必须是布尔值' };
    }

    if (typeof config.cronExpression !== 'string' || config.cronExpression.trim().length === 0) {
      return { success: false, error: 'cronExpression 必须是非空字符串' };
    }

    if (!Array.isArray(config.severityLevels) || config.severityLevels.length === 0) {
      return { success: false, error: 'severityLevels 必须是非空数组' };
    }

    for (const level of config.severityLevels) {
      if (!ALLOWED_SEVERITY_LEVELS.includes(level)) {
        return { success: false, error: `无效的严重级别: ${level}` };
      }
    }

    if (!Array.isArray(config.instanceWhitelist)) {
      return { success: false, error: 'instanceWhitelist 必须是数组' };
    }

    for (const id of config.instanceWhitelist) {
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        return { success: false, error: 'instanceWhitelist 中的元素必须是正整数' };
      }
    }

    if (typeof config.timeWindowStart !== 'string' || !HH_MM_REGEX.test(config.timeWindowStart)) {
      return { success: false, error: 'timeWindowStart 格式必须为 HH:MM' };
    }

    if (typeof config.timeWindowEnd !== 'string' || !HH_MM_REGEX.test(config.timeWindowEnd)) {
      return { success: false, error: 'timeWindowEnd 格式必须为 HH:MM' };
    }

    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)`,
        ['auto_analysis_config', JSON.stringify(config)]
      );
      return { success: true };
    } catch (error: any) {
      console.error('保存自动分析配置失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const aiAnalysisConfigService = new AiAnalysisConfigService();
