-- ============================================
-- Database Migration: RBAC Foundation
-- ============================================
-- Purpose: Create RBAC tables (roles, permissions, role_permissions,
--          user_roles, instance_permissions), seed default roles and
--          permission codes, migrate existing users from users.role
--          ENUM to user_roles table.
-- Date: 2026-05-09
-- ============================================

START TRANSACTION;

-- =========================================================================
-- 1. Create RBAC tables (5 tables)
-- =========================================================================

-- 1a. roles table
CREATE TABLE IF NOT EXISTS `roles` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `description` VARCHAR(255) DEFAULT NULL,
  `is_system` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '系统角色不可删除',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1b. permissions table
CREATE TABLE IF NOT EXISTS `permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(100) NOT NULL UNIQUE COMMENT 'resource:action 格式',
  `name` VARCHAR(100) NOT NULL COMMENT '权限名称',
  `description` VARCHAR(255) DEFAULT NULL,
  `resource` VARCHAR(50) NOT NULL COMMENT '资源类别',
  `action` VARCHAR(50) NOT NULL COMMENT '操作类型',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_code` (`code`),
  INDEX `idx_resource` (`resource`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1c. role_permissions junction table
CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `role_id` INT UNSIGNED NOT NULL,
  `permission_id` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_permission` (`role_id`, `permission_id`),
  CONSTRAINT `fk_rp_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rp_permission` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1d. user_roles junction table
CREATE TABLE IF NOT EXISTS `user_roles` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `role_id` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_role` (`user_id`, `role_id`),
  CONSTRAINT `fk_ur_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ur_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1e. instance_permissions table
CREATE TABLE IF NOT EXISTS `instance_permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `instance_id` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_instance` (`user_id`, `instance_id`),
  CONSTRAINT `fk_ip_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ip_instance` FOREIGN KEY (`instance_id`) REFERENCES `database_instances`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================================
-- 2. Seed default roles (matching existing SystemRole enum)
-- =========================================================================
INSERT IGNORE INTO `roles` (`name`, `description`, `is_system`) VALUES
('admin',     '超级管理员，拥有所有权限', TRUE),
('dba',       '数据库管理员，拥有运维相关权限', TRUE),
('developer', '开发人员，SQL 分析和优化权限', TRUE),
('analyst',   '分析师，只读和分析权限', TRUE),
('viewer',    '访客，基础查看权限', TRUE),
('auditor',   '审计员，查看 + 审计日志权限', TRUE);

-- =========================================================================
-- 3. Seed permission codes (resource:action format per D-01)
-- =========================================================================
INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`) VALUES
-- Instance operations
('instance:view',   '查看实例',    '查看数据库实例列表和详情', 'instance', 'view'),
('instance:create', '创建实例',    '创建新的数据库实例', 'instance', 'create'),
('instance:update', '更新实例',    '更新数据库实例配置', 'instance', 'update'),
('instance:delete', '删除实例',    '删除数据库实例', 'instance', 'delete'),
('instance:query',  '执行查询',    '在实例上执行 SQL 查询', 'instance', 'query'),
('instance:manage', '管理实例',    '重载连接、采集容量等管理操作', 'instance', 'manage'),
-- User operations
('user:view',   '查看用户',   '查看用户列表', 'user', 'view'),
('user:create', '创建用户',   '创建新用户', 'user', 'create'),
('user:update', '修改用户',   '修改用户信息', 'user', 'update'),
('user:delete', '删除用户',   '删除用户', 'user', 'delete'),
-- Notification operations
('notification:view',   '查看通知渠道',   '查看通知渠道列表', 'notification', 'view'),
('notification:manage', '管理通知渠道',   '创建/修改/删除/测试通知渠道', 'notification', 'manage'),
-- LLM operations
('llm:view',   '查看 LLM',   '查看 LLM 提供商配置', 'llm', 'view'),
('llm:manage', '管理 LLM',   '创建/修改/删除 LLM 配置', 'llm', 'manage'),
-- Alert operations
('alert:view',   '查看告警',   '查看告警列表和详情', 'alert', 'view'),
('alert:manage', '管理告警',   '确认/解决/删除告警', 'alert', 'manage'),
-- Approval operations
('approval:view',   '查看审批',   '查看审批请求', 'approval', 'view'),
('approval:approve','审批操作',   '审批/驳回 SQL 执行请求', 'approval', 'approve'),
-- Report operations
('report:view',   '查看报告',   '查看报告列表', 'report', 'view'),
('report:create', '生成报告',   '生成新报告', 'report', 'create'),
('report:export', '导出报告',   '导出/下载报告', 'report', 'export'),
-- Metric operations
('metric:view',   '查看指标',   '查看指标注册表和监控数据', 'metric', 'view'),
('metric:manage', '管理指标',   '创建/修改指标定义', 'metric', 'manage'),
-- Schema operations
('schema:view',   '查看表结构', '查看数据库表结构信息', 'schema', 'view'),
('schema:manage', '管理表结构', '创建/修改表结构', 'schema', 'manage'),
-- Index operations
('index:view',   '查看索引',   '查看索引信息', 'index', 'view'),
('index:manage', '管理索引',   '创建/删除索引', 'index', 'manage'),
-- Chat operations
('chat:view',   '查看聊天',   '查看聊天历史', 'chat', 'view'),
('chat:delete', '删除聊天',   '删除聊天记录', 'chat', 'delete'),
-- Config operations
('config:view',   '查看配置',   '查看系统配置', 'config', 'view'),
('config:manage', '管理配置',   '修改系统配置', 'config', 'manage'),
-- Audit operations
('audit:view',   '查看审计',   '查看审计日志', 'audit', 'view'),
('audit:export', '导出审计',   '导出审计日志', 'audit', 'export'),
-- Collector operations
('collector:view',   '查看采集任务',   '查看采集任务状态', 'collector', 'view'),
('collector:manage', '管理采集任务',   '启动/停止采集任务', 'collector', 'manage'),
-- Super-admin wildcard (D-02)
('*',            '所有权限',   '通配符，匹配所有操作', 'system', '*');

-- =========================================================================
-- 4. Assign default permissions to default roles
--    Based on existing DEFAULT_ROLE_POLICIES allow/deny patterns
-- =========================================================================

-- admin: all permissions (via '*' wildcard code in role_permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.code = '*';

-- dba: full instance access, limited user/alert/approval/system access
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'dba'
  AND p.code IN (
    'instance:view', 'instance:create', 'instance:update', 'instance:delete', 'instance:query', 'instance:manage',
    'user:view',
    'notification:view',
    'llm:view',
    'alert:view', 'alert:manage',
    'approval:view', 'approval:approve',
    'metric:view', 'metric:manage',
    'schema:view', 'schema:manage',
    'index:view', 'index:manage',
    'report:view', 'report:create', 'report:export',
    'config:view',
    'audit:view',
    'collector:view', 'collector:manage'
  );

-- developer: instance view/query/update, read-only on most resources
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'developer'
  AND p.code IN (
    'instance:view', 'instance:query', 'instance:update',
    'alert:view',
    'approval:view',
    'schema:view',
    'index:view',
    'metric:view',
    'report:view',
    'llm:view',
    'config:view'
  );

-- analyst: read-only across resources
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'analyst'
  AND p.code IN (
    'instance:view', 'instance:query',
    'alert:view',
    'metric:view',
    'report:view',
    'schema:view',
    'config:view'
  );

-- viewer: minimal read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'viewer'
  AND p.code IN (
    'instance:view',
    'alert:view',
    'metric:view'
  );

-- auditor: read-only + audit permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'auditor'
  AND p.code IN (
    'instance:view',
    'alert:view',
    'metric:view',
    'report:view',
    'config:view',
    'audit:view', 'audit:export'
  );

-- =========================================================================
-- 5. Migrate existing users from users.role ENUM to user_roles table
--    Per D-03: direct replacement in one transaction with backup column
-- =========================================================================

-- 5a. Create backup column for safety (following RESEARCH.md recommendation)
ALTER TABLE users ADD COLUMN role_backup VARCHAR(20) DEFAULT NULL AFTER role;
UPDATE users SET role_backup = role;

-- 5b. Map existing users to their default roles in user_roles
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON u.role = r.name
WHERE NOT EXISTS (
  SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = r.id
);

-- =========================================================================
-- 6. Deprecate old ENUM column
--    Drop role column after migration. Keep role_backup for one deployment
--    cycle (removed after Phase 85 verification per RESEARCH.md recommendation).
-- =========================================================================
ALTER TABLE users DROP COLUMN role;

COMMIT;
