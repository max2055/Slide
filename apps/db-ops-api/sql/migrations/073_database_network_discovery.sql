INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`)
VALUES ('network:discover', '发现数据库端点', '在预配置的受限网络中扫描允许网段的数据库端口', 'network', 'discover');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p ON p.code = 'network:discover'
WHERE r.name IN ('admin', 'dba');
