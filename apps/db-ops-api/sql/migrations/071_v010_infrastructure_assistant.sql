-- Slide v0.10 product identity and infrastructure-operations scope.
-- Idempotent so existing installations retain their migration history.
UPDATE system_config
SET config_value = 'v0.10'
WHERE config_key IN ('system.version', 'slide_version');

INSERT INTO system_config (config_key, config_value, value_type, description)
SELECT 'slide_version', 'v0.10', 'string', 'Slide 产品版本'
WHERE NOT EXISTS (
  SELECT 1 FROM system_config WHERE config_key = 'slide_version'
);
