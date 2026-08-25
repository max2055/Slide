-- Wave 0 network-device resource foundation.
-- Every statement is idempotent so an interrupted upgrade can be resumed.

CREATE TABLE IF NOT EXISTS `network_devices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '网络设备 ID',
  `name` VARCHAR(128) NOT NULL COMMENT '设备名称',
  `label` VARCHAR(255) DEFAULT NULL COMMENT '设备显示标签',
  `host` VARCHAR(255) NOT NULL COMMENT '设备地址或主机名',
  `site` VARCHAR(255) DEFAULT NULL COMMENT '设备站点',
  `vendor` ENUM('huawei') NOT NULL DEFAULT 'huawei' COMMENT '设备厂商',
  `model` VARCHAR(128) DEFAULT NULL COMMENT '设备型号',
  `os_version` VARCHAR(128) DEFAULT NULL COMMENT '网络操作系统版本',
  `serial_number` VARCHAR(128) DEFAULT NULL COMMENT '设备序列号',
  `snmp_port` SMALLINT UNSIGNED NOT NULL DEFAULT 161 COMMENT 'SNMP 端口',
  `ssh_port` SMALLINT UNSIGNED NOT NULL DEFAULT 22 COMMENT 'SSH 端口',
  `status` ENUM('unknown','online','offline','error','unreachable') NOT NULL DEFAULT 'unknown' COMMENT '设备状态',
  `last_check_at` DATETIME NULL COMMENT '最近检查时间',
  `collection_enabled` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否启用采集',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_network_device_host_snmp` (`host`, `snmp_port`),
  KEY `idx_network_device_status` (`status`),
  KEY `idx_network_device_collection` (`collection_enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='华为网络设备库存';

CREATE TABLE IF NOT EXISTS `network_device_credentials` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '网络设备凭据 ID',
  `device_id` BIGINT UNSIGNED NOT NULL COMMENT '网络设备 ID',
  `protocol` ENUM('snmpv3','ssh') NOT NULL COMMENT '凭据协议',
  `security_level` ENUM('noAuthNoPriv','authNoPriv','authPriv') DEFAULT NULL COMMENT 'SNMPv3 安全级别',
  `username` VARCHAR(128) NOT NULL COMMENT '协议用户名',
  `auth_protocol` VARCHAR(32) DEFAULT NULL COMMENT 'SNMPv3 认证算法',
  `privacy_protocol` VARCHAR(32) DEFAULT NULL COMMENT 'SNMPv3 加密算法',
  `auth_secret_encrypted` TEXT DEFAULT NULL COMMENT '加密存储的 SNMPv3 认证密钥',
  `privacy_secret_encrypted` TEXT DEFAULT NULL COMMENT '加密存储的 SNMPv3 隐私密钥',
  `credential_type` ENUM('password','key') DEFAULT NULL COMMENT 'SSH 凭据类型',
  `credential_encrypted` TEXT DEFAULT NULL COMMENT '加密存储的 SSH 密码或私钥',
  `host_key_fingerprint` VARCHAR(128) DEFAULT NULL COMMENT 'SSH 主机密钥指纹',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_network_device_credential_protocol` (`device_id`, `protocol`),
  KEY `idx_network_device_credentials_device` (`device_id`),
  CONSTRAINT `fk_network_device_credentials_device` FOREIGN KEY (`device_id`) REFERENCES `network_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='网络设备协议凭据';

CREATE TABLE IF NOT EXISTS `network_device_interfaces` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '接口记录 ID',
  `device_id` BIGINT UNSIGNED NOT NULL COMMENT '网络设备 ID',
  `if_index` INT UNSIGNED NOT NULL COMMENT '接口索引',
  `if_name` VARCHAR(255) NOT NULL COMMENT '接口名称',
  `if_alias` VARCHAR(255) DEFAULT NULL COMMENT '接口别名',
  `speed_bps` BIGINT UNSIGNED DEFAULT NULL COMMENT '接口速率（bit/s）',
  `admin_status` ENUM('up','down','testing','unknown') NOT NULL DEFAULT 'unknown' COMMENT '管理状态',
  `oper_status` ENUM('up','down','testing','unknown') NOT NULL DEFAULT 'unknown' COMMENT '运行状态',
  `last_seen_at` DATETIME NULL COMMENT '最近观测时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_network_device_interface` (`device_id`, `if_index`),
  KEY `idx_network_device_interface_seen` (`device_id`, `last_seen_at`),
  CONSTRAINT `fk_network_device_interfaces_device` FOREIGN KEY (`device_id`) REFERENCES `network_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='网络设备接口库存';

CREATE TABLE IF NOT EXISTS `network_device_observations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '网络设备观测 ID',
  `device_id` BIGINT UNSIGNED NOT NULL COMMENT '网络设备 ID',
  `metric_id` VARCHAR(128) NOT NULL COMMENT '标准化指标 ID',
  `dimensions` JSON DEFAULT NULL COMMENT '指标维度',
  `metric_value` DECIMAL(24,8) DEFAULT NULL COMMENT '指标值',
  `observed_at` DATETIME(6) NOT NULL COMMENT '观测时间',
  `valid_until` DATETIME(6) DEFAULT NULL COMMENT '观测有效期',
  `quality` ENUM('good','degraded','invalid','unknown') NOT NULL DEFAULT 'unknown' COMMENT '观测质量',
  `source` VARCHAR(128) NOT NULL COMMENT '观测来源',
  `reason` VARCHAR(512) DEFAULT NULL COMMENT '质量说明',
  PRIMARY KEY (`id`),
  KEY `idx_network_device_observation_latest` (`device_id`, `metric_id`, `observed_at`),
  CONSTRAINT `fk_network_device_observations_device` FOREIGN KEY (`device_id`) REFERENCES `network_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='网络设备观测数据';

CREATE TABLE IF NOT EXISTS `network_device_config_backups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '配置备份 ID',
  `device_id` BIGINT UNSIGNED NOT NULL COMMENT '网络设备 ID',
  `version_no` INT UNSIGNED NOT NULL COMMENT '设备配置版本号',
  `content_encrypted` MEDIUMTEXT NOT NULL COMMENT '加密后的配置原文',
  `content_sha256` CHAR(64) NOT NULL COMMENT '配置明文 SHA-256 摘要',
  `source_protocol` ENUM('ssh','netconf') NOT NULL COMMENT '配置采集协议',
  `collected_at` DATETIME NOT NULL COMMENT '采集时间',
  `size_bytes` INT UNSIGNED NOT NULL COMMENT '配置明文大小（字节）',
  `redaction_status` ENUM('redacted','unredacted','failed') NOT NULL DEFAULT 'redacted' COMMENT '脱敏状态',
  `created_by` INT UNSIGNED DEFAULT NULL COMMENT '触发用户 ID',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_network_device_backup_version` (`device_id`, `version_no`),
  UNIQUE KEY `uq_network_device_backup_hash` (`device_id`, `content_sha256`),
  KEY `idx_network_device_backup_time` (`device_id`, `collected_at`),
  CONSTRAINT `fk_network_device_config_backups_device` FOREIGN KEY (`device_id`) REFERENCES `network_devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_network_device_config_backups_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_network_device_backup_size` CHECK (`size_bytes` <= 2097152)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='网络设备配置备份';

-- Keep the hash de-duplication invariant when the table predates migration 070.
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE network_device_config_backups ADD UNIQUE KEY uq_network_device_backup_hash (device_id, content_sha256)',
  'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'network_device_config_backups' AND INDEX_NAME = 'uq_network_device_backup_hash');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

-- Extend generic resource enums while retaining all existing values.
SET @slide_070_sql = (
  SELECT IF(COUNT(*) > 0,
    'ALTER TABLE resource_relations MODIFY COLUMN source_type ENUM(''instance'',''server'',''network_device'') NOT NULL COMMENT ''关系源资源类型'', MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL COMMENT ''关系目标资源类型'', MODIFY COLUMN relation_type ENUM(''runs_on'',''hosts'',''replicates_to'',''depends_on'',''connected_to'',''serves'') NOT NULL COMMENT ''关系类型''',
    'SELECT 1')
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_relations'
);
PREPARE slide_070_stmt FROM @slide_070_sql;
EXECUTE slide_070_stmt;
DEALLOCATE PREPARE slide_070_stmt;

SET @slide_070_sql = (
  SELECT IF(COUNT(*) > 0,
    'ALTER TABLE resource_capabilities MODIFY COLUMN resource_type ENUM(''instance'',''server'',''network_device'') NOT NULL COMMENT ''资源类型''',
    'SELECT 1')
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_capabilities'
);
PREPARE slide_070_stmt FROM @slide_070_sql;
EXECUTE slide_070_stmt;
DEALLOCATE PREPARE slide_070_stmt;

-- Add network-device target columns before widening target enums.
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_rules ADD COLUMN network_device_id BIGINT UNSIGNED NULL COMMENT ''网络设备 ID'' AFTER server_id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alerts ADD COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''告警目标类型'' AFTER id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alerts ADD COLUMN network_device_id BIGINT UNSIGNED NULL COMMENT ''网络设备 ID'' AFTER server_id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_events ADD COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''事件目标类型'' AFTER id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_events ADD COLUMN network_device_id BIGINT UNSIGNED NULL COMMENT ''网络设备 ID'' AFTER server_id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND COLUMN_NAME = 'network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

-- Widen pre-existing target_type columns as well as newly-added columns. A
-- column-existence check alone leaves old instance/server enums unchanged.
SET @slide_070_sql = (SELECT IF(COUNT(*) > 0 AND MAX(LOCATE('network_device', COLUMN_TYPE)) = 0, 'ALTER TABLE alert_rules MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''目标类型''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) > 0 AND MAX(LOCATE('network_device', COLUMN_TYPE)) = 0, 'ALTER TABLE alert_rule_templates MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''目标类型''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rule_templates' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) > 0 AND MAX(LOCATE('network_device', COLUMN_TYPE)) = 0, 'ALTER TABLE metric_definitions MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''目标类型''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

SET @slide_070_sql = (SELECT IF(COUNT(*) > 0 AND MAX(LOCATE('network_device', COLUMN_TYPE)) = 0, 'ALTER TABLE alerts MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''告警目标类型''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) > 0 AND MAX(LOCATE('network_device', COLUMN_TYPE)) = 0, 'ALTER TABLE alert_events MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''事件目标类型''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

-- Add indexes and foreign keys only once.
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_rules ADD INDEX idx_alert_rule_network_device (network_device_id)', 'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND INDEX_NAME = 'idx_alert_rule_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alerts ADD INDEX idx_alert_network_device (network_device_id)', 'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND INDEX_NAME = 'idx_alert_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_events ADD INDEX idx_alert_event_network_device (network_device_id)', 'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND INDEX_NAME = 'idx_alert_event_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_rules ADD CONSTRAINT fk_alert_rule_network_device FOREIGN KEY (network_device_id) REFERENCES network_devices(id) ON DELETE CASCADE', 'SELECT 1') FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND CONSTRAINT_NAME = 'fk_alert_rule_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alerts ADD CONSTRAINT fk_alert_network_device FOREIGN KEY (network_device_id) REFERENCES network_devices(id) ON DELETE CASCADE', 'SELECT 1') FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND CONSTRAINT_NAME = 'fk_alert_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE alert_events ADD CONSTRAINT fk_alert_event_network_device FOREIGN KEY (network_device_id) REFERENCES network_devices(id) ON DELETE CASCADE', 'SELECT 1') FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND CONSTRAINT_NAME = 'fk_alert_event_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

-- Extend analysis/report subjects without rewriting historical rows.
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE ai_analysis ADD COLUMN network_device_id BIGINT UNSIGNED NULL COMMENT ''网络设备 ID'' AFTER server_id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_analysis' AND COLUMN_NAME = 'network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) > 0 AND MAX(LOCATE('network_device', COLUMN_TYPE)) = 0, 'ALTER TABLE ai_analysis MODIFY COLUMN target_type ENUM(''instance'',''server'',''network_device'') NOT NULL DEFAULT ''instance'' COMMENT ''分析目标类型''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_analysis' AND COLUMN_NAME = 'target_type');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE ai_analysis ADD INDEX idx_ai_analysis_network_device (network_device_id)', 'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_analysis' AND INDEX_NAME = 'idx_ai_analysis_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE ai_analysis ADD CONSTRAINT fk_ai_analysis_network_device FOREIGN KEY (network_device_id) REFERENCES network_devices(id) ON DELETE CASCADE', 'SELECT 1') FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_analysis' AND CONSTRAINT_NAME = 'fk_ai_analysis_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE reports ADD COLUMN network_device_id BIGINT UNSIGNED NULL COMMENT ''网络设备 ID'' AFTER server_id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE reports ADD INDEX idx_report_network_device_id (network_device_id)', 'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND INDEX_NAME = 'idx_report_network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE reports ADD CONSTRAINT fk_report_network_device FOREIGN KEY (network_device_id) REFERENCES network_devices(id) ON DELETE CASCADE', 'SELECT 1') FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND CONSTRAINT_NAME = 'fk_report_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE report_configs ADD COLUMN network_device_id BIGINT UNSIGNED NULL COMMENT ''网络设备 ID'' AFTER server_id', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_configs' AND COLUMN_NAME = 'network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE report_configs ADD INDEX idx_report_config_network_device_id (network_device_id)', 'SELECT 1') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_configs' AND INDEX_NAME = 'idx_report_config_network_device_id');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;
SET @slide_070_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE report_configs ADD CONSTRAINT fk_report_config_network_device FOREIGN KEY (network_device_id) REFERENCES network_devices(id) ON DELETE CASCADE', 'SELECT 1') FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'report_configs' AND CONSTRAINT_NAME = 'fk_report_config_network_device');
PREPARE slide_070_stmt FROM @slide_070_sql; EXECUTE slide_070_stmt; DEALLOCATE PREPARE slide_070_stmt;

-- Permission seeds: admin and network-operator may manage/backup; DBA is read-only.
INSERT IGNORE INTO `roles` (`name`, `description`, `is_system`) VALUES ('network-operator', '网络设备运维专员', TRUE);
INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`) VALUES
  ('network_devices:view', '查看网络设备', '查看网络设备库存和观测', 'network_devices', 'view'),
  ('network_devices:manage', '管理网络设备', '新增、修改和删除网络设备', 'network_devices', 'manage'),
  ('network_devices:backup', '查看配置备份', '查看和恢复网络设备配置备份', 'network_devices', 'backup');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('network_devices:view','network_devices:manage','network_devices:backup') WHERE r.name IN ('admin','network-operator');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'network_devices:view' WHERE r.name = 'dba';
