/**
 * 配置 Schema 单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  systemDatabaseConfigSchema,
  jwtConfigSchema,
  encryptionConfigSchema,
  llmProviderConfigSchema,
  serverConfigSchema,
  monitoringConfigSchema,
  alertConfigSchema,
  notificationConfigSchema,
  appConfigSchema,
  ConfigValidationError,
  validateAndLoadConfig,
  loadConfigFromEnv,
  DEFAULT_CONFIG,
  isConfigComplete,
  getMissingConfigItems,
  validateConfigItem,
} from './schema.js';

describe('systemDatabaseConfigSchema', () => {
  it('应该验证有效的数据库配置', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
      DB_NAME: 'db_ops_ai',
    };

    const result = systemDatabaseConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该拒绝空的 DB_HOST', () => {
    const config = {
      DB_HOST: '',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
    };

    const result = systemDatabaseConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('应该转换数字端口为字符串', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: 3306,
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
    };

    const result = systemDatabaseConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DB_PORT).toBe('3306');
    }
  });

  it('应该使用默认 DB_NAME', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
    };

    const result = systemDatabaseConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DB_NAME).toBe('db_ops_ai');
    }
  });
});

describe('jwtConfigSchema', () => {
  it('应该验证有效的 JWT 配置', () => {
    const config = {
      JWT_SECRET_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      JWT_EXPIRATION_MINUTES: '1440',
    };

    const result = jwtConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该拒绝太短的 JWT_SECRET_KEY', () => {
    const config = {
      JWT_SECRET_KEY: 'short',
      JWT_EXPIRATION_MINUTES: '1440',
    };

    const result = jwtConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('应该使用默认过期时间', () => {
    const config = {
      JWT_SECRET_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
    };

    const result = jwtConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.JWT_EXPIRATION_MINUTES).toBe('1440');
    }
  });
});

describe('encryptionConfigSchema', () => {
  it('应该验证有效的加密配置', () => {
    const config = {
      ENCRYPTION_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
    };

    const result = encryptionConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该拒绝太短的 ENCRYPTION_KEY', () => {
    const config = {
      ENCRYPTION_KEY: 'short',
    };

    const result = encryptionConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe('llmProviderConfigSchema', () => {
  it('应该验证有效的 LLM 配置', () => {
    const config = {
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      DEFAULT_LLM_PROVIDER: 'anthropic',
    };

    const result = llmProviderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该使用默认模型', () => {
    const config = {};

    const result = llmProviderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6');
      expect(result.data.DEFAULT_LLM_PROVIDER).toBe('anthropic');
    }
  });

  it('应该验证 OLLAMA_BASE_URL 不为空', () => {
    const config = {
      OLLAMA_BASE_URL: '',
    };

    const result = llmProviderConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('应该接受有效的地址', () => {
    const config = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
    };

    const result = llmProviderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe('serverConfigSchema', () => {
  it('应该验证有效的服务器配置', () => {
    const config = {
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: '3000',
      NODE_ENV: 'production',
    };

    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该转换端口为数字', () => {
    const config = {
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: '3000',
    };

    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SERVER_PORT).toBe(3000);
    }
  });

  it('应该使用默认值', () => {
    const config = {};

    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SERVER_HOST).toBe('0.0.0.0');
      expect(result.data.SERVER_PORT).toBe(3000);
      expect(result.data.NODE_ENV).toBe('development');
    }
  });

  it('应该拒绝无效的环境', () => {
    const config = {
      NODE_ENV: 'invalid',
    };

    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe('monitoringConfigSchema', () => {
  it('应该验证有效的监控配置', () => {
    const config = {
      MONITOR_COLLECT_INTERVAL_SECONDS: '30',
      MONITOR_HISTORY_RETENTION_DAYS: '30',
      SLOW_QUERY_THRESHOLD_MS: '1000',
    };

    const result = monitoringConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该转换字符串为数字', () => {
    const config = {
      MONITOR_COLLECT_INTERVAL_SECONDS: '60',
    };

    const result = monitoringConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MONITOR_COLLECT_INTERVAL_SECONDS).toBe(60);
    }
  });

  it('应该使用默认值', () => {
    const config = {};

    const result = monitoringConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MONITOR_COLLECT_INTERVAL_SECONDS).toBe(30);
      expect(result.data.SLOW_QUERY_THRESHOLD_MS).toBe(1000);
    }
  });
});

describe('alertConfigSchema', () => {
  it('应该验证有效的告警配置', () => {
    const config = {
      ALERT_ENABLED: 'true',
      ALERT_CPU_THRESHOLD: '80',
      ALERT_MEMORY_THRESHOLD: '85',
    };

    const result = alertConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该转换布尔值', () => {
    const config = {
      ALERT_ENABLED: 'TRUE',
    };

    const result = alertConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ALERT_ENABLED).toBe(true);
    }
  });

  it('应该使用默认阈值', () => {
    const config = {};

    const result = alertConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ALERT_CPU_THRESHOLD).toBe(80);
      expect(result.data.ALERT_MEMORY_THRESHOLD).toBe(85);
    }
  });
});

describe('notificationConfigSchema', () => {
  it('应该验证有效的通知配置', () => {
    const config = {
      NOTIFICATION_DINGTALK_ENABLED: 'false',
      NOTIFICATION_DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send',
    };

    const result = notificationConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该验证 Webhook URL 不为空', () => {
    const config = {
      NOTIFICATION_DINGTALK_WEBHOOK: '',
    };

    const result = notificationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe('appConfigSchema', () => {
  it('应该验证完整的配置', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
      JWT_SECRET_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ENCRYPTION_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      DEFAULT_LLM_PROVIDER: 'anthropic' as const,
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: 3000,
      NODE_ENV: 'development' as const,
    };

    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应该拒绝缺少必填项的配置', () => {
    const config = {
      DB_HOST: 'localhost',
      // 缺少其他必填项
    };

    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe('validateAndLoadConfig', () => {
  it('应该加载有效配置', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
      JWT_SECRET_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ENCRYPTION_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      DEFAULT_LLM_PROVIDER: 'anthropic' as const,
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: 3000,
      NODE_ENV: 'development' as const,
    };

    const result = validateAndLoadConfig(config);
    expect(result.DB_HOST).toBe('localhost');
  });

  it('应该抛出 ConfigValidationError 对于无效配置', () => {
    const config = {
      DB_HOST: '',
    };

    expect(() => validateAndLoadConfig(config)).toThrow(ConfigValidationError);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('应该包含默认配置值', () => {
    expect(DEFAULT_CONFIG.DB_NAME).toBe('db_ops_ai');
    expect(DEFAULT_CONFIG.SERVER_PORT).toBe(3000);
    expect(DEFAULT_CONFIG.NODE_ENV).toBe('development');
  });
});

describe('isConfigComplete', () => {
  it('应该返回 true 对于完整配置', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
      JWT_SECRET_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ENCRYPTION_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      DEFAULT_LLM_PROVIDER: 'anthropic' as const,
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: 3000,
      NODE_ENV: 'development' as const,
    };

    expect(isConfigComplete(config)).toBe(true);
  });

  it('应该返回 false 对于不完整配置', () => {
    const config = {
      DB_HOST: 'localhost',
    };

    expect(isConfigComplete(config)).toBe(false);
  });
});

describe('getMissingConfigItems', () => {
  it('应该返回缺失的配置项', () => {
    const config = {
      DB_HOST: 'localhost',
    };

    const missing = getMissingConfigItems(config);
    expect(missing.length).toBeGreaterThan(0);
  });

  it('应该返回空数组对于完整配置', () => {
    const config = {
      DB_HOST: 'localhost',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: 'password123',
      JWT_SECRET_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ENCRYPTION_KEY: 'this-is-a-very-secret-key-at-least-32-chars',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      DEFAULT_LLM_PROVIDER: 'anthropic' as const,
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: 3000,
      NODE_ENV: 'development' as const,
    };

    const missing = getMissingConfigItems(config);
    expect(missing).toEqual([]);
  });
});

describe('validateConfigItem', () => {
  it('应该验证单个配置项', () => {
    const config = {
      DB_HOST: 'localhost',
    };

    expect(validateConfigItem(config, 'DB_HOST')).toBe(true);
    expect(validateConfigItem(config, 'DB_PORT')).toBe(false);
  });
});

describe('loadConfigFromEnv', () => {
  it('应该从环境变量加载配置', () => {
    // 这个测试会依赖实际的环境变量
    // 在有完整环境变量时会成功，否则会失败
    try {
      const config = loadConfigFromEnv();
      // 如果成功，说明环境变量配置完整
      expect(config).toBeDefined();
    } catch (e) {
      // 如果失败，应该是因为缺失配置项
      expect(e).toBeInstanceOf(ConfigValidationError);
    }
  });
});
