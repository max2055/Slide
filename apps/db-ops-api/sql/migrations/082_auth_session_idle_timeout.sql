-- Seed the configurable idle timeout without rewriting the immutable baseline.
INSERT IGNORE INTO system_config (config_key, config_value, value_type, description)
VALUES (
  'auth.session_idle_timeout_minutes',
  '10080',
  'number',
  '登录会话无操作超时时间（分钟）；每次刷新令牌轮换后重新计时'
);
