/**
 * 配置 Schema 定义
 *
 * 复用 OpenClaw 的 config schema 模式
 * 使用 Zod 进行配置验证
 */

import { z } from 'zod';

// ============================================
// 1. 数据库配置
// ============================================

/**
 * 系统数据库配置 Schema
 */
export const systemDatabaseConfigSchema = z.object({
  DB_HOST: z.string().min(1).describe('数据库主机'),
  DB_PORT: z.string().or(z.number()).transform(String).describe('数据库端口'),
  DB_USER: z.string().min(1).describe('数据库用户'),
  DB_PASSWORD: z.string().min(1).describe('数据库密码'),
  DB_NAME: z.string().min(1).default('db_ops_ai').describe('数据库名称'),
  DB_CHARSET: z.string().default('utf8mb4').describe('数据库字符集'),
});

export type SystemDatabaseConfig = z.infer<typeof systemDatabaseConfigSchema>;

// ============================================
// 2. JWT 认证配置
// ============================================

/**
 * JWT 配置 Schema
 */
export const jwtConfigSchema = z.object({
  JWT_SECRET_KEY: z.string().min(32).describe('JWT 密钥（至少 32 字符）'),
  JWT_EXPIRATION_MINUTES: z.string().or(z.number()).transform(String).default('1440').describe('JWT 过期时间（分钟）'),
});

export type JWTConfig = z.infer<typeof jwtConfigSchema>;

// ============================================
// 3. 加密配置
// ============================================

/**
 * 加密配置 Schema
 */
export const encryptionConfigSchema = z.object({
  ENCRYPTION_KEY: z.string().min(32).describe('加密密钥（至少 32 字符）'),
});

export type EncryptionConfig = z.infer<typeof encryptionConfigSchema>;

// ============================================
// 4. LLM 配置
// ============================================

/**
 * LLM 提供商配置 Schema
 */
export const llmProviderConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional().describe('Anthropic API 密钥'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6').describe('Anthropic 默认模型'),
  OPENAI_API_KEY: z.string().optional().describe('OpenAI API 密钥'),
  OPENAI_MODEL: z.string().default('gpt-4.1').describe('OpenAI 默认模型'),
  OLLAMA_BASE_URL: z.string().min(1).optional().describe('Ollama 服务地址'),
  OLLAMA_MODEL: z.string().default('qwen2.5-coder:32b').describe('Ollama 默认模型'),
  DEEPSEEK_API_KEY: z.string().optional().describe('DeepSeek API 密钥'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat').describe('DeepSeek 默认模型'),
  DEFAULT_LLM_PROVIDER: z.enum(['anthropic', 'openai', 'ollama', 'deepseek']).default('anthropic').describe('默认 LLM 提供商'),
});

export type LLMProviderConfig = z.infer<typeof llmProviderConfigSchema>;

// ============================================
// 5. 服务器配置
// ============================================

/**
 * 服务器配置 Schema
 */
export const serverConfigSchema = z.object({
  SERVER_HOST: z.string().min(1).optional().default('0.0.0.0').describe('服务器监听地址'),
  SERVER_PORT: z.string().or(z.number()).transform(Number).default(3000).describe('服务器端口'),
  NODE_ENV: z.enum(['development', 'staging', 'production', 'testing']).default('development').describe('运行环境'),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

// ============================================
// 6. 监控配置
// ============================================

/**
 * 监控配置 Schema
 */
export const monitoringConfigSchema = z.object({
  MONITOR_COLLECT_INTERVAL_SECONDS: z.string().or(z.number()).transform(Number).default(30).describe('监控采集间隔（秒）'),
  MONITOR_HISTORY_RETENTION_DAYS: z.string().or(z.number()).transform(Number).default(30).describe('监控历史保留天数'),
  SLOW_QUERY_THRESHOLD_MS: z.string().or(z.number()).transform(Number).default(1000).describe('慢查询阈值（毫秒）'),
});

export type MonitoringConfig = z.infer<typeof monitoringConfigSchema>;

// ============================================
// 7. 告警配置
// ============================================

/**
 * 告警配置 Schema
 */
export const alertConfigSchema = z.object({
  ALERT_ENABLED: z.string().transform(s => s.toLowerCase() === 'true').default('true').describe('是否启用告警'),
  ALERT_CPU_THRESHOLD: z.string().or(z.number()).transform(Number).default(80).describe('CPU 告警阈值（%）'),
  ALERT_MEMORY_THRESHOLD: z.string().or(z.number()).transform(Number).default(85).describe('内存告警阈值（%）'),
  ALERT_CONNECTION_THRESHOLD: z.string().or(z.number()).transform(Number).default(100).describe('连接数告警阈值'),
  ALERT_QPS_THRESHOLD: z.string().or(z.number()).transform(Number).default(5000).describe('QPS 告警阈值'),
  ALERT_SLOW_QUERY_THRESHOLD: z.string().or(z.number()).transform(Number).default(10).describe('慢查询告警阈值'),
  ALERT_HEALTH_SCORE_THRESHOLD: z.string().or(z.number()).transform(Number).default(60).describe('健康分数告警阈值'),
});

export type AlertConfig = z.infer<typeof alertConfigSchema>;

// ============================================
// 8. 通知配置
// ============================================

/**
 * 通知配置 Schema
 */
export const notificationConfigSchema = z.object({
  NOTIFICATION_DINGTALK_ENABLED: z.string().transform(s => s.toLowerCase() === 'true').default('false').describe('是否启用钉钉通知'),
  NOTIFICATION_DINGTALK_WEBHOOK: z.string().min(1).optional().describe('钉钉 Webhook URL'),
  NOTIFICATION_WECOM_ENABLED: z.string().transform(s => s.toLowerCase() === 'true').default('false').describe('是否启用企业微信通知'),
  NOTIFICATION_WECOM_WEBHOOK: z.string().min(1).optional().describe('企业微信 Webhook URL'),
  NOTIFICATION_FEISHU_ENABLED: z.string().transform(s => s.toLowerCase() === 'true').default('false').describe('是否启用飞书通知'),
  NOTIFICATION_FEISHU_WEBHOOK: z.string().min(1).optional().describe('飞书 Webhook URL'),
});

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;

// ============================================
// 9. 会话配置
// ============================================

/**
 * 会话配置 Schema
 */
export const sessionConfigSchema = z.object({
  SESSION_SECRET: z.string().min(32).describe('会话密钥'),
  SESSION_MAX_AGE_SECONDS: z.string().or(z.number()).transform(Number).default(86400).describe('会话最大存活时间（秒）'),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;

// ============================================
// 10. 完整配置
// ============================================

/**
 * 完整应用配置 Schema
 */
export const appConfigSchema = z.object({
  // 数据库
  ...systemDatabaseConfigSchema.shape,
  // JWT
  ...jwtConfigSchema.shape,
  // 加密
  ...encryptionConfigSchema.shape,
  // LLM
  ...llmProviderConfigSchema.shape,
  // 服务器
  ...serverConfigSchema.shape,
  // 监控
  ...monitoringConfigSchema.shape,
  // 告警
  ...alertConfigSchema.shape,
  // 通知
  ...notificationConfigSchema.shape,
});

export type AppConfig = z.infer<typeof appConfigSchema>;

// ============================================
// 配置验证和加载
// ============================================

/**
 * 配置验证错误
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public errors: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * 验证并加载配置
 */
export function validateAndLoadConfig(env: Record<string, unknown>): AppConfig {
  const result = appConfigSchema.safeParse(env);

  if (!result.success) {
    const errorMessage = result.error.issues
      ? result.error.issues.map(e => (e.path?.length > 0 ? e.path.join('.') + ': ' : '') + e.message).join(', ')
      : '未知错误';
    throw new ConfigValidationError(
      `配置验证失败：${errorMessage}`,
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * 从环境变量加载配置
 */
export function loadConfigFromEnv(): AppConfig {
  return validateAndLoadConfig(process.env);
}

/**
 * 获取配置的部分值
 */
export function getPartialConfig<K extends keyof AppConfig>(
  env: Record<string, unknown>,
  keys: K[],
): Pick<AppConfig, K> {
  const partialSchema = appConfigSchema.pick({ [keys[0]]: true });
  const result = partialSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigValidationError(
      `配置验证失败：${result.error.errors.map(e => e.path.join('.') + ': ' + e.message).join(', ')}`,
      result.error.issues,
    );
  }

  return result.data as Pick<AppConfig, K>;
}

// ============================================
// 配置默认值
// ============================================

/**
 * 配置默认值
 */
export const DEFAULT_CONFIG: Partial<AppConfig> = {
  DB_NAME: 'db_ops_ai',
  DB_CHARSET: 'utf8mb4',
  JWT_EXPIRATION_MINUTES: '1440',
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',
  OPENAI_MODEL: 'gpt-4.1',
  OLLAMA_MODEL: 'qwen2.5-coder:32b',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEFAULT_LLM_PROVIDER: 'anthropic',
  SERVER_HOST: '0.0.0.0',
  SERVER_PORT: 3000,
  NODE_ENV: 'development',
  MONITOR_COLLECT_INTERVAL_SECONDS: 30,
  MONITOR_HISTORY_RETENTION_DAYS: 30,
  SLOW_QUERY_THRESHOLD_MS: 1000,
  ALERT_ENABLED: true,
  ALERT_CPU_THRESHOLD: 80,
  ALERT_MEMORY_THRESHOLD: 85,
  ALERT_CONNECTION_THRESHOLD: 100,
  ALERT_QPS_THRESHOLD: 5000,
  ALERT_SLOW_QUERY_THRESHOLD: 10,
  ALERT_HEALTH_SCORE_THRESHOLD: 60,
  NOTIFICATION_DINGTALK_ENABLED: false,
  NOTIFICATION_WECOM_ENABLED: false,
  NOTIFICATION_FEISHU_ENABLED: false,
};

// ============================================
// 配置辅助函数
// ============================================

/**
 * 检查配置是否完整
 */
export function isConfigComplete(env: Record<string, unknown>): boolean {
  return appConfigSchema.safeParse(env).success;
}

/**
 * 获取配置缺失项
 */
export function getMissingConfigItems(env: Record<string, unknown>): string[] {
  const result = appConfigSchema.safeParse(env);

  if (result.success) {
    return [];
  }

  const missingItems = new Set<string>();

  for (const error of result.error.issues) {
    const path = error.path.join('.');
    missingItems.add(path);
  }

  return Array.from(missingItems);
}

/**
 * 验证配置项是否存在
 */
export function validateConfigItem<K extends keyof AppConfig>(
  env: Record<string, unknown>,
  key: K,
): boolean {
  const schema = appConfigSchema.shape[key];

  if (!schema) {
    return false;
  }

  return schema.safeParse(env[key]).success;
}
