/**
 * LLM 配置数据库服务 - 重构版
 * 支持完整的 Provider 配置、用量追踪、成本统计
 */
import mysql from 'mysql2/promise';
import { dbConnection, encryptData, decryptData } from './db-connection';

// 部署方式
export type DeploymentType = 'local' | 'cloud' | 'api';

// 模型信息
export interface ModelInfo {
  id: string;
  name: string;
  recommended?: boolean;
  desc?: string;
}

// LLM Provider 完整配置
export interface LLMProvider {
  id: number;
  name: string;
  display_name: string;
  deployment_type: DeploymentType;
  api_key_encrypted: string | null;
  api_format: string | null;
  api_base_url: string | null;
  default_model: string | null;
  models_supported: ModelInfo[] | null;
  context_window: number;
  supports_function_call: boolean;
  supports_vision: boolean;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
  enabled: boolean;
  is_default: boolean;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  rate_limit_per_minute: number;
  daily_quota: number | null;
  daily_quota_alert_threshold: number;
  created_at: Date;
  updated_at: Date;
}

// Provider 配置输入（不含敏感信息）
export interface LLMProviderConfig {
  name: string;
  displayName?: string;
  deploymentType?: DeploymentType;
  apiKey?: string;
  apiFormat?: string;
  model?: string;
  baseURL?: string;
  modelsSupported?: ModelInfo[];
  contextWindow?: number;
  supportsFunctionCall?: boolean;
  supportsVision?: boolean;
  inputCostPer1k?: number;
  outputCostPer1k?: number;
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  rateLimitPerMinute?: number;
  dailyQuota?: number | null;
  dailyQuotaAlertThreshold?: number;
}

// 用量记录
export interface LLMUsageRecord {
  id: number;
  provider_id: number;
  provider_name: string;
  model: string;
  user_id: number | null;
  session_id: string;
  instance_id: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
  status: 'success' | 'error';
  error_message: string | null;
  purpose: string | null;
  created_at: Date;
}

// 每日用量统计
export interface LLMUsageDailyStats {
  provider_id: number;
  provider_name: string;
  model: string;
  date: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  failed_requests: number;
  avg_duration_ms: number;
  unique_users: number;
  unique_sessions: number;
}

// 配额告警
export interface LLMQuotaAlert {
  id: number;
  provider_id: number;
  alert_type: 'daily_quota' | 'cost_limit' | 'rate_limit';
  threshold_value: number;
  notification_channel_ids: number[];
  enabled: boolean;
  last_triggered_at: Date | null;
  trigger_count_today: number;
}

class LLMDatabaseService {
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
   * 解析 JSON 字段
   */
  private parseJsonField<T>(data: any, field: string): T | null {
    if (!data[field]) return null;
    try {
      return typeof data[field] === 'string' ? JSON.parse(data[field]) : data[field];
    } catch {
      return null;
    }
  }

  /**
   * 获取所有提供商
   */
  async getAllProviders(): Promise<LLMProvider[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM llm_providers ORDER BY is_default DESC, deployment_type, name`
      ) as any;

      return (rows as any[]).map(row => ({
        ...row,
        enabled: Boolean(row.enabled),
        models_supported: this.parseJsonField<ModelInfo[]>(row, 'models_supported'),
      }));
    } catch (error) {
      console.error('获取 LLM 提供商列表失败:', error);
      return [];
    }
  }

  /**
   * 获取启用的提供商
   */
  async getEnabledProviders(): Promise<LLMProvider[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM llm_providers WHERE enabled = TRUE ORDER BY is_default DESC, name`
      ) as any;

      return (rows as any[]).map(row => ({
        ...row,
        enabled: Boolean(row.enabled),
        models_supported: this.parseJsonField<ModelInfo[]>(row, 'models_supported'),
      }));
    } catch (error) {
      console.error('获取启用的 LLM 提供商失败:', error);
      return [];
    }
  }

  /**
   * 获取默认提供商
   */
  async getDefaultProvider(): Promise<LLMProvider | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM llm_providers WHERE is_default = TRUE AND enabled = TRUE LIMIT 1`
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        return {
          ...row,
          enabled: Boolean(row.enabled),
          models_supported: this.parseJsonField<ModelInfo[]>(row, 'models_supported'),
        };
      }
      return null;
    } catch (error) {
      console.error('获取默认 LLM 提供商失败:', error);
      return null;
    }
  }

  /**
   * 根据名称获取提供商
   */
  async getProviderByName(name: string): Promise<LLMProvider | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM llm_providers WHERE name = ?`,
        [name]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        return {
          ...row,
          enabled: Boolean(row.enabled),
          models_supported: this.parseJsonField<ModelInfo[]>(row, 'models_supported'),
        };
      }
      return null;
    } catch (error) {
      console.error('获取 LLM 提供商失败:', error);
      return null;
    }
  }

  /**
   * 根据 ID 获取提供商
   */
  async getProviderById(id: number): Promise<LLMProvider | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM llm_providers WHERE id = ?`,
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        return {
          ...row,
          enabled: Boolean(row.enabled),
          models_supported: this.parseJsonField<ModelInfo[]>(row, 'models_supported'),
        };
      }
      return null;
    } catch (error) {
      console.error('获取 LLM 提供商失败:', error);
      return null;
    }
  }

  /**
   * 根据部署类型获取提供商
   */
  async getProvidersByDeploymentType(type: DeploymentType): Promise<LLMProvider[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM llm_providers WHERE deployment_type = ? ORDER BY name`,
        [type]
      ) as any;

      return (rows as any[]).map(row => ({
        ...row,
        models_supported: this.parseJsonField<ModelInfo[]>(row, 'models_supported'),
      }));
    } catch (error) {
      console.error('获取 LLM 提供商失败:', error);
      return [];
    }
  }

  /**
   * 获取提供商的 API Key（解密后）
   */
  async getProviderApiKey(name: string): Promise<string | null> {
    const provider = await this.getProviderByName(name);
    if (!provider || !provider.api_key_encrypted) {
      return null;
    }

    try {
      return decryptData(provider.api_key_encrypted);
    } catch (error) {
      console.error('解密 API Key 失败:', error);
      return null;
    }
  }

  /**
   * 配置提供商
   */
  async configureProvider(config: LLMProviderConfig): Promise<{ success: boolean; error?: string; providerId?: number }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const existing = await this.getProviderByName(config.name);

      if (existing) {
        // 更新
        const updates: string[] = [];
        const values: any[] = [];

        if (config.displayName !== undefined) {
          updates.push('display_name = ?');
          values.push(config.displayName);
        }
        if (config.deploymentType !== undefined) {
          updates.push('deployment_type = ?');
          values.push(config.deploymentType);
        }
        if (config.apiFormat !== undefined) {
          updates.push('api_format = ?');
          values.push(config.apiFormat || null);
        }
        if (config.apiKey !== undefined && config.apiKey.trim() !== '') {
          updates.push('api_key_encrypted = ?');
          values.push(encryptData(config.apiKey));
        }
        if (config.model !== undefined) {
          updates.push('default_model = ?');
          values.push(config.model);
        }
        if (config.baseURL !== undefined) {
          updates.push('api_base_url = ?');
          values.push(config.baseURL);
        }
        if (config.modelsSupported !== undefined) {
          updates.push('models_supported = ?');
          values.push(JSON.stringify(config.modelsSupported));
        }
        if (config.contextWindow !== undefined) {
          updates.push('context_window = ?');
          values.push(config.contextWindow);
        }
        if (config.supportsFunctionCall !== undefined) {
          updates.push('supports_function_call = ?');
          values.push(config.supportsFunctionCall ? 1 : 0);
        }
        if (config.supportsVision !== undefined) {
          updates.push('supports_vision = ?');
          values.push(config.supportsVision ? 1 : 0);
        }
        if (config.inputCostPer1k !== undefined) {
          updates.push('input_cost_per_1k = ?');
          values.push(config.inputCostPer1k);
        }
        if (config.outputCostPer1k !== undefined) {
          updates.push('output_cost_per_1k = ?');
          values.push(config.outputCostPer1k);
        }
        if (config.enabled !== undefined) {
          updates.push('enabled = ?');
          values.push(config.enabled ? 1 : 0);
        }
        if (config.temperature !== undefined) {
          updates.push('temperature = ?');
          values.push(config.temperature);
        }
        if (config.maxTokens !== undefined) {
          updates.push('max_tokens = ?');
          values.push(config.maxTokens);
        }
        if (config.timeoutMs !== undefined) {
          updates.push('timeout_ms = ?');
          values.push(config.timeoutMs);
        }
        if (config.rateLimitPerMinute !== undefined) {
          updates.push('rate_limit_per_minute = ?');
          values.push(config.rateLimitPerMinute);
        }
        if (config.dailyQuota !== undefined) {
          updates.push('daily_quota = ?');
          values.push(config.dailyQuota);
        }
        if (config.dailyQuotaAlertThreshold !== undefined) {
          updates.push('daily_quota_alert_threshold = ?');
          values.push(config.dailyQuotaAlertThreshold);
        }

        if (updates.length > 0) {
          values.push(config.name);
          await pool.execute(
            `UPDATE llm_providers SET ${updates.join(', ')} WHERE name = ?`,
            values
          );
        }

        return { success: true, providerId: existing.id };
      } else {
        // 插入
        const result = await pool.execute(
          `INSERT INTO llm_providers
           (name, display_name, deployment_type, api_format, api_key_encrypted, api_base_url, default_model,
            models_supported, context_window, supports_function_call, supports_vision,
            input_cost_per_1k, output_cost_per_1k, enabled, temperature, max_tokens,
            timeout_ms, rate_limit_per_minute, daily_quota, daily_quota_alert_threshold)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            config.name,
            config.displayName || config.name.toUpperCase(),
            config.deploymentType || 'api',
            config.apiFormat || null,
            config.apiKey ? encryptData(config.apiKey) : null,
            config.baseURL || null,
            config.model || null,
            config.modelsSupported ? JSON.stringify(config.modelsSupported) : null,
            config.contextWindow || 4096,
            config.supportsFunctionCall ? 1 : 0,
            config.supportsVision ? 1 : 0,
            config.inputCostPer1k || 0,
            config.outputCostPer1k || 0,
            config.enabled !== false ? 1 : 0,
            config.temperature ?? 0.7,
            config.maxTokens ?? 2048,
            config.timeoutMs ?? 30000,
            config.rateLimitPerMinute ?? 60,
            config.dailyQuota ?? null,
            config.dailyQuotaAlertThreshold ?? 80,
          ]
        );

        return { success: true, providerId: (result[0] as any).insertId };
      }
    } catch (error: any) {
      console.error('配置 LLM 提供商失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 设置默认提供商
   */
  async setDefaultProvider(name: string): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 先取消所有默认
      await pool.execute('UPDATE llm_providers SET is_default = FALSE');
      // 设置新的默认
      await pool.execute('UPDATE llm_providers SET is_default = TRUE WHERE name = ?', [name]);
      return { success: true };
    } catch (error: any) {
      console.error('设置默认提供商失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 启用/禁用提供商
   */
  async toggleProvider(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute('UPDATE llm_providers SET enabled = ? WHERE name = ?', [enabled ? 1 : 0, name]);
      return { success: true };
    } catch (error: any) {
      console.error('切换提供商状态失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除提供商
   */
  async deleteProvider(name: string): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute('DELETE FROM llm_providers WHERE name = ?', [name]);
      return { success: true };
    } catch (error: any) {
      console.error('删除提供商失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 记录用量
   */
  async recordUsage(record: {
    provider_id: number;
    provider_name: string;
    model: string;
    user_id?: number | null;
    session_id: string;
    instance_id?: number | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd?: number;
    duration_ms?: number;
    status?: 'success' | 'error';
    error_message?: string | null;
    purpose?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const total_tokens = record.input_tokens + record.output_tokens;
      const cost = record.cost_usd ?? 0;
      const duration = record.duration_ms ?? 0;
      const status = record.status ?? 'success';
      const error = record.error_message ?? null;
      const purpose = record.purpose ?? null;

      // 插入用量记录
      await pool.execute(
        `INSERT INTO llm_usage_records
         (provider_id, provider_name, model, user_id, session_id, instance_id,
          input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, status, error_message, purpose)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.provider_id,
          record.provider_name,
          record.model,
          record.user_id ?? null,
          record.session_id,
          record.instance_id ?? null,
          record.input_tokens,
          record.output_tokens,
          total_tokens,
          cost,
          duration,
          status,
          error,
          purpose,
        ]
      );

      // 更新每日统计
      const today = new Date().toISOString().split('T')[0];
      await pool.execute(
        `INSERT INTO llm_usage_daily_stats
         (provider_id, provider_name, model, date, total_requests, total_input_tokens, total_output_tokens,
          total_tokens, total_cost_usd, failed_requests, avg_duration_ms, unique_users, unique_sessions)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1)
         ON DUPLICATE KEY UPDATE
           total_requests = total_requests + 1,
           total_input_tokens = total_input_tokens + VALUES(total_input_tokens),
           total_output_tokens = total_output_tokens + VALUES(total_output_tokens),
           total_tokens = total_tokens + VALUES(total_tokens),
           total_cost_usd = total_cost_usd + VALUES(total_cost_usd),
           failed_requests = failed_requests + ${status === 'error' ? 1 : 0},
           avg_duration_ms = (avg_duration_ms * (total_requests - 1) + ${duration}) / total_requests`,
        [
          record.provider_id,
          record.provider_name,
          record.model,
          today,
          record.input_tokens,
          record.output_tokens,
          total_tokens,
          cost,
          status === 'error' ? 1 : 0,
          duration,
        ]
      );

      return { success: true };
    } catch (error: any) {
      console.error('记录用量失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取用量统计（按日期范围）
   */
  async getUsageStats(options: {
    provider_id?: number;
    provider_name?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<LLMUsageDailyStats[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const conditions: string[] = [];
      const values: any[] = [];

      if (options.provider_id) {
        conditions.push('provider_id = ?');
        values.push(options.provider_id);
      }
      if (options.provider_name) {
        conditions.push('provider_name = ?');
        values.push(options.provider_name);
      }
      if (options.start_date) {
        conditions.push('date >= ?');
        values.push(options.start_date);
      }
      if (options.end_date) {
        conditions.push('date <= ?');
        values.push(options.end_date);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limitClause = options.limit ? `LIMIT ${options.limit}` : '';

      const [rows] = await pool.execute(
        `SELECT * FROM llm_usage_daily_stats ${whereClause} ORDER BY date DESC ${limitClause}`,
        values
      ) as any;

      return rows as LLMUsageDailyStats[];
    } catch (error) {
      console.error('获取用量统计失败:', error);
      return [];
    }
  }

  /**
   * 获取总用量和成本统计
   */
  async getUsageSummary(options: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    total_requests: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    unique_providers: number;
    unique_models: number;
  }> {
    const pool = this.getPool();
    if (!pool) {
      return {
        total_requests: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        unique_providers: 0,
        unique_models: 0,
      };
    }

    try {
      const conditions: string[] = [];
      const values: any[] = [];

      if (options.start_date) {
        conditions.push('created_at >= ?');
        values.push(options.start_date);
      }
      if (options.end_date) {
        conditions.push('created_at <= ?');
        values.push(options.end_date);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const [rows] = await pool.execute(
        `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COUNT(DISTINCT provider_id) as unique_providers,
          COUNT(DISTINCT model) as unique_models
         FROM llm_usage_records ${whereClause}`,
        values
      ) as any;

      const row = rows[0];
      return {
        total_requests: row.total_requests,
        total_input_tokens: row.total_input_tokens,
        total_output_tokens: row.total_output_tokens,
        total_cost_usd: row.total_cost_usd,
        unique_providers: row.unique_providers,
        unique_models: row.unique_models,
      };
    } catch (error) {
      console.error('获取用量汇总失败:', error);
      return {
        total_requests: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        unique_providers: 0,
        unique_models: 0,
      };
    }
  }

  /**
   * 获取 Provider 用量排名
   */
  async getProviderUsageRanking(options: {
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<Array<{
    provider_id: number;
    provider_name: string;
    total_requests: number;
    total_tokens: number;
    total_cost_usd: number;
    percentage: number;
  }>> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const conditions: string[] = [];
      const values: any[] = [];

      if (options.start_date) {
        conditions.push('created_at >= ?');
        values.push(options.start_date);
      }
      if (options.end_date) {
        conditions.push('created_at <= ?');
        values.push(options.end_date);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limitClause = options.limit ? `LIMIT ${options.limit}` : '';

      const [rows] = await pool.execute(
        `SELECT
          provider_id,
          provider_name,
          COUNT(*) as total_requests,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as total_cost_usd
         FROM llm_usage_records ${whereClause}
         GROUP BY provider_id, provider_name
         ORDER BY total_cost_usd DESC
         ${limitClause}`,
        values
      ) as any;

      const total = rows.reduce((sum: number, r: any) => sum + r.total_cost_usd, 0);

      return rows.map((r: any) => ({
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        total_requests: r.total_requests,
        total_tokens: r.total_tokens,
        total_cost_usd: r.total_cost_usd,
        percentage: total > 0 ? (r.total_cost_usd / total) * 100 : 0,
      }));
    } catch (error) {
      console.error('获取 Provider 用量排名失败:', error);
      return [];
    }
  }

  /**
   * 获取配额告警配置
   */
  async getQuotaAlerts(provider_id?: number): Promise<LLMQuotaAlert[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const conditions: string[] = [];
      const values: any[] = [];

      if (provider_id) {
        conditions.push('provider_id = ?');
        values.push(provider_id);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const [rows] = await pool.execute(
        `SELECT * FROM llm_quota_alerts ${whereClause} ORDER BY provider_id, alert_type`,
        values
      ) as any;

      return (rows as any[]).map(row => ({
        ...row,
        notification_channel_ids: this.parseJsonField<number[]>(row, 'notification_channel_ids'),
      }));
    } catch (error) {
      console.error('获取配额告警失败:', error);
      return [];
    }
  }

  /**
   * 配置配额告警
   */
  async configureQuotaAlert(alert: {
    provider_id: number;
    alert_type: 'daily_quota' | 'cost_limit' | 'rate_limit';
    threshold_value: number;
    notification_channel_ids?: number[];
    enabled?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `INSERT INTO llm_quota_alerts
         (provider_id, alert_type, threshold_value, notification_channel_ids, enabled)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           threshold_value = VALUES(threshold_value),
           notification_channel_ids = VALUES(notification_channel_ids),
           enabled = VALUES(enabled)`,
        [
          alert.provider_id,
          alert.alert_type,
          alert.threshold_value,
          alert.notification_channel_ids ? JSON.stringify(alert.notification_channel_ids) : null,
          alert.enabled !== undefined ? (alert.enabled ? 1 : 0) : 1,
        ]
      );

      return { success: true };
    } catch (error: any) {
      console.error('配置配额告警失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 记录配额告警触发
   */
  async triggerQuotaAlert(alert_id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const today = new Date().toISOString().split('T')[0];
      await pool.execute(
        `UPDATE llm_quota_alerts
         SET last_triggered_at = NOW(), trigger_count_today = trigger_count_today + 1
         WHERE id = ?`,
        [alert_id]
      );

      return { success: true };
    } catch (error: any) {
      console.error('记录告警触发失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const llmDatabaseService = new LLMDatabaseService();
