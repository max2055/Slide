-- Migration 019: Add servers table and permissions
--
-- Description: Create servers table for SSH server management,
--              seed servers:view/servers:manage permissions,
--              assign to admin and dba roles.
--
-- Requirements: SRV-01 (server CRUD), SRV-02 (SSH credential storage),
--               SRV-03 (SSH connection test), SRV-06 (key rotation)

START TRANSACTION;

-- ========================================
-- Section 1: servers table
-- ========================================
CREATE TABLE IF NOT EXISTS `servers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `host` VARCHAR(255) NOT NULL COMMENT 'IP address or hostname',
  `port` INT UNSIGNED NOT NULL DEFAULT 22 COMMENT 'SSH port',
  `label` VARCHAR(255) DEFAULT NULL COMMENT 'optional display alias',
  `os_type` VARCHAR(50) NOT NULL COMMENT 'CentOS/Ubuntu/Debian/RHEL/Other',
  `credential_type` ENUM('password','key') NOT NULL COMMENT 'SSH auth type',
  `credential_encrypted` TEXT NOT NULL COMMENT 'AES-256-CBC encrypted JSON: {username, password/key content}',
  `host_key_fingerprint` VARCHAR(255) DEFAULT NULL COMMENT 'SSH host key fingerprint (Phase 125+)',
  `status` ENUM('online','offline','error','unreachable') NOT NULL DEFAULT 'offline',
  `last_check_at` DATETIME DEFAULT NULL,
  `collection_enabled` TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'per D-04: added server = collection active by default',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_host` (`host`),
  INDEX `idx_status` (`status`),
  INDEX `idx_collection_enabled` (`collection_enabled`),
  UNIQUE INDEX `uq_host_port` (`host`, `port`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================
-- Section 2: permission seeds
-- ========================================
INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`) VALUES
('servers:view',   '查看服务器', '查看服务器列表和详情', 'servers', 'view'),
('servers:manage', '管理服务器', '添加/编辑/删除服务器，测试连接，轮换密钥', 'servers', 'manage');

-- ========================================
-- Section 3: role-permission assignments
-- ========================================

-- admin gets both servers:view AND servers:manage
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.code IN ('servers:view', 'servers:manage');

-- dba gets both servers:view AND servers:manage
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'dba' AND p.code IN ('servers:view', 'servers:manage');

COMMIT;
