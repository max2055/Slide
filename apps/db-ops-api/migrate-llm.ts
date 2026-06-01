#!/usr/bin/env node
/**
 * LLM 配置功能升级迁移脚本
 * 执行时间：2026-04-10
 */

import 'dotenv/config';
import * as mysql from 'mysql2/promise';

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'db_ops_ai',
};

async function runMigration() {
  console.log('🔧 开始执行 LLM 配置迁移...');
  console.log(`📍 连接目标：${config.host}:${config.port}/${config.database}`);

  let connection;

  try {
    connection = await mysql.createConnection(config);
    console.log('✅ MySQL 连接成功');

    // 1. 备份现有数据
    console.log('📦 备份 llm_providers 表...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS llm_providers_backup AS
      SELECT * FROM llm_providers
    `);
    console.log('✅ 备份完成');

    // 2. 检查并添加 deployment_type 字段
    console.log('📝 添加 deployment_type 字段...');
    const [cols]: any = await connection.query(`
      SHOW COLUMNS FROM llm_providers LIKE 'deployment_type'
    `);
    if (cols.length === 0) {
      await connection.query(`
        ALTER TABLE llm_providers
        ADD COLUMN deployment_type_tmp ENUM('local', 'cloud', 'api') NOT NULL DEFAULT 'api'
        COMMENT '部署方式：local=本地，cloud=云服务，api=厂商 API'
      `);
      console.log('✅ 添加 deployment_type_tmp 字段');

      // 根据 name 设置 deployment_type
      await connection.query(`UPDATE llm_providers SET deployment_type_tmp = 'local' WHERE name = 'ollama'`);
      await connection.query(`UPDATE llm_providers SET deployment_type_tmp = 'cloud' WHERE name IN ('aliyun', 'kimi')`);
      await connection.query(`UPDATE llm_providers SET deployment_type_tmp = 'api' WHERE name IN ('anthropic', 'openai', 'deepseek')`);
      console.log('✅ 更新 deployment_type 值');

      // 修改 name 字段为 VARCHAR
      await connection.query(`ALTER TABLE llm_providers MODIFY name VARCHAR(50) NOT NULL`);

      // 重命名为正式字段
      await connection.query(`
        ALTER TABLE llm_providers
        CHANGE deployment_type_tmp deployment_type
        ENUM('local', 'cloud', 'api') NOT NULL DEFAULT 'api'
        COMMENT '部署方式：local=本地，cloud=云服务，api=厂商 API'
      `);
      console.log('✅ deployment_type 字段迁移完成');
    } else {
      console.log('⏭️  deployment_type 字段已存在，跳过');
    }

    // 3. 添加其他新字段
    const newFields = [
      { name: 'models_supported', sql: 'JSON DEFAULT NULL COMMENT \'支持的模型列表 JSON\'' },
      { name: 'context_window', sql: 'INT DEFAULT 4096 COMMENT \'最大上下文长度 (tokens)\'' },
      { name: 'supports_function_call', sql: 'BOOLEAN DEFAULT FALSE' },
      { name: 'supports_vision', sql: 'BOOLEAN DEFAULT FALSE' },
      { name: 'input_cost_per_1k', sql: 'DECIMAL(10,6) DEFAULT 0 COMMENT \'每 1K 输入 token 价格 (USD)\'' },
      { name: 'output_cost_per_1k', sql: 'DECIMAL(10,6) DEFAULT 0 COMMENT \'每 1K 输出 token 价格 (USD)\'' },
      { name: 'daily_quota', sql: 'INT DEFAULT NULL COMMENT \'每日 token 配额限制\'' },
      { name: 'daily_quota_alert_threshold', sql: 'INT DEFAULT 80 COMMENT \'每日配额告警阈值 (%) \'' },
    ];

    for (const field of newFields) {
      const [cols]: any = await connection.query(`SHOW COLUMNS FROM llm_providers LIKE '${field.name}'`);
      if (cols.length === 0) {
        await connection.query(`ALTER TABLE llm_providers ADD COLUMN ${field.name} ${field.sql}`);
        console.log(`✅ 添加 ${field.name} 字段`);
      } else {
        console.log(`⏭️  ${field.name} 字段已存在，跳过`);
      }
    }

    // 添加索引
    console.log('📇 添加索引...');
    await connection.query(`ALTER TABLE llm_providers ADD INDEX idx_deployment_type (deployment_type)`);
    console.log('✅ 索引添加完成');

    // 4. 更新现有 Provider 数据
    console.log('📝 更新 Provider 配置数据...');

    await connection.query(`
      UPDATE llm_providers SET
        display_name = '阿里云百炼',
        models_supported = '[{"id":"qwen-plus","name":"Qwen-Plus","recommended":true,"desc":"平衡性能与成本"},{"id":"qwen-max","name":"Qwen-Max","desc":"最强性能"},{"id":"qwen-turbo","name":"Qwen-Turbo","desc":"快速响应"}]',
        context_window = 128000,
        supports_function_call = TRUE,
        input_cost_per_1k = 0.002,
        output_cost_per_1k = 0.006
      WHERE name = 'aliyun'
    `);

    await connection.query(`
      UPDATE llm_providers SET
        display_name = 'Ollama 本地',
        models_supported = '[{"id":"qwen2.5-coder:32b","name":"Qwen2.5-Coder 32B","desc":"代码生成"},{"id":"qwen2.5:32b","name":"Qwen2.5 32B","desc":"通用对话"}]',
        context_window = 32768,
        supports_function_call = TRUE,
        input_cost_per_1k = 0,
        output_cost_per_1k = 0
      WHERE name = 'ollama'
    `);

    await connection.query(`
      UPDATE llm_providers SET
        display_name = 'Anthropic Claude',
        models_supported = '[{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","recommended":true,"desc":"性价比最高"},{"id":"claude-opus-4-6","name":"Claude Opus 4.6","desc":"最强性能"}]',
        context_window = 200000,
        supports_function_call = TRUE,
        supports_vision = TRUE,
        input_cost_per_1k = 0.003,
        output_cost_per_1k = 0.015
      WHERE name = 'anthropic'
    `);

    await connection.query(`
      UPDATE llm_providers SET
        display_name = 'OpenAI GPT',
        models_supported = '[{"id":"gpt-4.1","name":"GPT-4.1","recommended":true,"desc":"最新模型"},{"id":"gpt-4-turbo","name":"GPT-4 Turbo","desc":"快速"}]',
        context_window = 128000,
        supports_function_call = TRUE,
        supports_vision = TRUE,
        input_cost_per_1k = 0.005,
        output_cost_per_1k = 0.015
      WHERE name = 'openai'
    `);

    await connection.query(`
      UPDATE llm_providers SET
        display_name = '深度求索',
        models_supported = '[{"id":"deepseek-chat","name":"DeepSeek Chat","recommended":true,"desc":"对话模型"}]',
        context_window = 128000,
        supports_function_call = TRUE,
        input_cost_per_1k = 0.001,
        output_cost_per_1k = 0.002
      WHERE name = 'deepseek'
    `);

    console.log('✅ Provider 数据更新完成');

    // 5. 创建用量记录表
    console.log('📊 创建 llm_usage_records 表...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS llm_usage_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        provider_id INT UNSIGNED NOT NULL,
        provider_name VARCHAR(50) NOT NULL,
        model VARCHAR(100) NOT NULL,
        user_id INT UNSIGNED DEFAULT NULL,
        session_id VARCHAR(64) NOT NULL,
        instance_id INT UNSIGNED DEFAULT NULL,
        input_tokens INT NOT NULL DEFAULT 0,
        output_tokens INT NOT NULL DEFAULT 0,
        total_tokens INT NOT NULL DEFAULT 0,
        cost_usd DECIMAL(10,6) DEFAULT 0,
        duration_ms INT DEFAULT 0,
        status ENUM('success', 'error') NOT NULL DEFAULT 'success',
        error_message TEXT DEFAULT NULL,
        purpose VARCHAR(50) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_provider_id (provider_id),
        INDEX idx_provider_name (provider_name),
        INDEX idx_user_id (user_id),
        INDEX idx_session_id (session_id),
        INDEX idx_created_at (created_at),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ llm_usage_records 表创建完成');

    // 6. 创建每日用量统计表
    console.log('📈 创建 llm_usage_daily_stats 表...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS llm_usage_daily_stats (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        provider_id INT UNSIGNED NOT NULL,
        provider_name VARCHAR(50) NOT NULL,
        model VARCHAR(100) NOT NULL,
        date DATE NOT NULL,
        total_requests INT NOT NULL DEFAULT 0,
        total_input_tokens BIGINT NOT NULL DEFAULT 0,
        total_output_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        total_cost_usd DECIMAL(10,6) DEFAULT 0,
        failed_requests INT DEFAULT 0,
        avg_duration_ms INT DEFAULT 0,
        unique_users INT DEFAULT 0,
        unique_sessions INT DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY idx_provider_date_model (provider_id, date, model),
        INDEX idx_date (date),
        INDEX idx_provider_name (provider_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ llm_usage_daily_stats 表创建完成');

    // 7. 创建配额告警表
    console.log('🔔 创建 llm_quota_alerts 表...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS llm_quota_alerts (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        provider_id INT UNSIGNED NOT NULL,
        alert_type ENUM('daily_quota', 'cost_limit', 'rate_limit') NOT NULL,
        threshold_value DECIMAL(10,2) NOT NULL,
        notification_channel_ids JSON DEFAULT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_triggered_at DATETIME DEFAULT NULL,
        trigger_count_today INT DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_provider_id (provider_id),
        INDEX idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ llm_quota_alerts 表创建完成');

    // 8. 更新 ai_chat_history 表
    console.log('📝 更新 ai_chat_history 表...');
    const chatCols: any = await connection.query(`SHOW COLUMNS FROM ai_chat_history LIKE 'provider_id'`);
    if (chatCols.length === 0) {
      await connection.query(`
        ALTER TABLE ai_chat_history
        ADD COLUMN provider_id INT UNSIGNED DEFAULT NULL COMMENT '使用的 LLM 提供商 ID' AFTER instance_id,
        ADD COLUMN input_tokens INT DEFAULT 0 AFTER tokens_used,
        ADD COLUMN output_tokens INT DEFAULT 0 AFTER input_tokens,
        ADD COLUMN cost_usd DECIMAL(10,6) DEFAULT 0 COMMENT '本次调用成本 (USD)' AFTER output_tokens,
        ADD COLUMN purpose VARCHAR(50) DEFAULT NULL COMMENT '调用目的' AFTER duration_ms
      `);
      await connection.query(`ALTER TABLE ai_chat_history MODIFY COLUMN model VARCHAR(100) DEFAULT NULL`);
      console.log('✅ ai_chat_history 表更新完成');
    } else {
      console.log('⏭️  ai_chat_history 已更新，跳过');
    }

    // 9. 插入默认配额告警配置
    console.log('🔔 插入默认配额告警配置...');
    await connection.query(`
      INSERT IGNORE INTO llm_quota_alerts (provider_id, alert_type, threshold_value, enabled)
      SELECT id, 'daily_quota', 80, TRUE FROM llm_providers WHERE name = 'aliyun'
    `);
    console.log('✅ 配额告警配置完成');

    console.log('\n===========================================');
    console.log('✅ 迁移执行完成！');
    console.log('===========================================');

  } catch (error: any) {
    console.error('❌ 迁移执行失败:', error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

runMigration().catch(console.error);
