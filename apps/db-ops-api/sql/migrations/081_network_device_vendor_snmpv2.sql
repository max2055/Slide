-- Allow vendor-neutral enrollment and SNMPv2c community credentials.
SET @slide_081_sql = (SELECT IF(COUNT(*) > 0,
  'ALTER TABLE network_devices MODIFY COLUMN vendor ENUM(''huawei'',''cisco'') NOT NULL DEFAULT ''huawei'' COMMENT ''设备厂商''',
  'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_devices' AND COLUMN_NAME = 'vendor');
PREPARE slide_081_stmt FROM @slide_081_sql; EXECUTE slide_081_stmt; DEALLOCATE PREPARE slide_081_stmt;

SET @slide_081_sql = (SELECT IF(COUNT(*) > 0,
  'ALTER TABLE network_device_credentials MODIFY COLUMN protocol ENUM(''snmpv2c'',''snmpv3'',''ssh'') NOT NULL COMMENT ''凭据协议''',
  'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_device_credentials' AND COLUMN_NAME = 'protocol');
PREPARE slide_081_stmt FROM @slide_081_sql; EXECUTE slide_081_stmt; DEALLOCATE PREPARE slide_081_stmt;

SET @slide_081_sql = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE network_device_credentials ADD COLUMN community_encrypted TEXT DEFAULT NULL COMMENT ''加密存储的 SNMPv2c community'' AFTER privacy_secret_encrypted',
  'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_device_credentials' AND COLUMN_NAME = 'community_encrypted');
PREPARE slide_081_stmt FROM @slide_081_sql; EXECUTE slide_081_stmt; DEALLOCATE PREPARE slide_081_stmt;
