-- Migration 013: Add db_types and instance_ids scoping columns to alert_rules
ALTER TABLE `alert_rules`
  ADD COLUMN `db_types` JSON DEFAULT NULL
  COMMENT '适用的数据库类型，从关联指标继承；NULL=所有类型'
  AFTER `notification_channels`;

ALTER TABLE `alert_rules`
  ADD COLUMN `instance_ids` JSON DEFAULT NULL
  COMMENT '适用的实例ID列表，NULL=所有实例'
  AFTER `db_types`;
